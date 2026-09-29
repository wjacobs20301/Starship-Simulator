// Owns the world state: vehicles, time, events. Steps physics at a fixed dt and
// produces render/telemetry snapshots in the pad's local ENU frame.

import { G0, MU, OMEGA_E, PAD, DEG } from './constants';
import { MISSION, STARSHIP_V3, SUPER_HEAVY_V3 } from './config/starshipV3';
import { type Aux, DEFAULT_ENV, type Env, currentAux, rk4Step } from './dynamics';
import { engineMassFlow, engineThrust } from './engine';
import { Pilot, type PilotCommand } from './pilot';
import { ecefToEci, ecefToEnuMatrix, ecefToGeodetic, eciToEcef, eciToEcefMatrix, enuBasis, geodeticToEcef, localBasisEci } from './frames';
import { orbitApsides } from './guidance';
import {
  type M3, type V3, add, clamp, cross, dot, mat3FromColumns, mat3FromQ, mat3Mul, mat3Vec, norm, qFromMat3, qrot,
  qrotInv, scale, sub, normalize,
  type Q, qmul,
} from './math';
import { CATCH, type CatchGuide } from './boosterReturn';
import { type Contact, type Cylinder, MOUNTS, TOWERS, type TowerState, armContact, awayFromTower, catchGap, catchPoint, cylinder, deepestContact, surfaceUnder } from './padCollision';
import { eciDirToPad, eciToPad, eciVelToPad, padDirToEci, padToEci } from './padFrame';
import { ARMS, TowerArms } from './tower';
import { SHIP_ENTRY, heatFlux } from './shipReentry';
import { airRelativeVelocity } from './frames';
import { Mission, type Phase } from './sequencer';
import { type ReturnTarget, SHIP_CATCH_PIN, ShipReturn, targetLatLon } from './shipReturn';
import { type VehicleHealth, checkLimits, newHealth } from './limits';
import { type EntryModel, type Trajectory, orbitalFrame, predictTrajectory, propagate } from './trajectory';

/** Where the menu's orbit backdrop has the ship (deg), and its heading (deg from north). */
export const ORBIT_SCENE = { lat: 26.0, lon: -97.2, alt: 250e3, heading: 70 };

/**
 * Where a mission starts: on the pad, or part-way through a real flight (run ahead to there):
 * just after stage separation, the booster falling back toward its landing burn, or the ship at
 * the edge of the atmosphere on its way down.
 */
export type MissionStart = 'pad' | 'separation' | 'boosterLanding' | 'entry';

/** Main-menu backdrops (Simulation.scene). */
export type MenuScene = 'pad' | 'liftoff' | 'orbit' | 'reentry' | 'shipCaught' | 'boosterCatch' | 'shipCatch';

/** The booster-catch backdrop starts here (mission time, s): on the landing burn, ~30 s from the catch. */
export const CATCH_SCENE_T = 384;
/**
 * The ship coming home to the tower, 40 km up in its entry over the Gulf: a state saved from a
 * full flight's return (sim time t, ECI, SI units). The 'shipCatch' scene flies on from it.
 */
const SHIP_HOME_40KM = {
  t: 80498.52178092382,
  r: [-3139855.5150597794, -4848720.97757845, 2787792.7988642296] as V3,
  v: [2842.777394135258, -1611.680492027086, 155.02431534383132] as V3,
  q: [0.525483458676233, -0.6259381427283031, -0.18835544802387597, -0.5446015069160487] as Q,
  w: [0.0022156939460694167, -0.0013968065512410873, -0.0016133154886852595] as V3,
  prop: 85225.55276083859,
  surfaces: [0.9375261359209751, 0.9622071611889854, 0.9616072818461029, 0.9874996961556918],
};
/** How far into that return the scene starts, s: ten seconds before the flip. */
const SHIP_CATCH_SCENE_T = 212;

/** A planned burn: sim time and delta-v along prograde / normal / radial-out (m/s). */
export interface ManeuverNode {
  vehicle: string;
  t: number;
  dv: V3;
}

/** Above this altitude, with engines quiet, time warp goes on rails (no aerodynamics, no attitude dynamics). */
export const RAILS_ALT = 140e3;
/** Chopsticks capture radius: a hull this close to the catch point (at arm height) gets centred, m. */
const CAPTURE_RADIUS = 2.5;
/** Speed into a structure (m/s) that wrecks both it and the vehicle. */
const CRASH_SPEED = { arm: 4, tower: 3, qd: 6 };
/** Pushing on the ship QD arm faster than this bends it out of the way (wrecks it), m/s. */
const QD_BREAK_SPEED = 0.8;
/** Fastest warp that still steps the full physics. */
export const PHYSICS_WARP_MAX = 50;
/** Rails warp stops this long before a planned burn starts, s (time for the ship to turn to it). */
const RAILS_BURN_LEAD = 90;

/** The ship's entry as flown by its autopilot, measured from the sim (flaps included): approx. */

import { type StageId, Vehicle, massProps } from './vehicle';

export const DT = 0.01;

export interface SimEvent {
  t: number;
  missionTime: number | null;
  text: string;
}

export interface VehicleSnapshot {
  id: string;
  name: string;
  status: Vehicle['status'];
  stages: StageId[];
  /** Body origin (booster base) in pad ENU, m. */
  pos: V3;
  /** Body -> ENU rotation, row-major. */
  rot: M3;
  xcg: number;
  telemetry: {
    altitude: number; // m above ground
    speed: number; // m/s relative to the ground/air
    inertialSpeed: number;
    verticalSpeed: number;
    downrange: number; // m along the surface from the pad
    mach: number;
    q: number; // Pa
    accelG: number;
    pAmb: number;
    mass: number;
    perigee: number;
    apogee: number;
    alphaDeg: number;
    /** Body -> local ENU (at the vehicle) rotation, row-major: the navball's attitude. */
    rotLocal: M3;
    /** Air-relative and inertial velocity, and the orbit normal (unit), in local ENU. */
    vSurfLocal: V3;
    vOrbLocal: V3;
    normalLocal: V3;
    /** Thrust-to-weight now and at full throttle on the running engines' stage. */
    twr: number;
    twrMax: number;
    /** Delta-v left per stage at the current ambient pressure, m/s (booster includes the ship). */
    deltaV: Partial<Record<StageId, number>>;
    /** Stagnation-point convective heating estimate, W/m^2. */
    heatFlux: number;
    /** Geodetic latitude / longitude, degrees. */
    lat: number;
    lon: number;
    /** Air-relative velocity in pad ENU, m/s (drives the reentry plasma's direction). */
    vAirEnu: V3;
  };
  /** Structural load / heat damage (limits.ts). */
  health: VehicleHealth;
  /** Flap / grid fin angles (rad), by model node name. */
  surfaces: { name: string; angle: number }[];
  /** Venting propellant overboard now (for the vent effect). */
  venting: boolean;
  /** Per stage: propellant fraction, engine throttles (0..1), and the common TVC gimbal. */
  stageState: Partial<Record<StageId, {
    propFrac: number;
    throttles: number[];
    gimbalDeg: number;
    /** Gimbal angles (gy, gz) of the steerable engines, rad. */
    gimbal: [number, number];
    /** Which engines can gimbal. */
    gimbals: boolean[];
  }>>;
}

export interface Snapshot {
  t: number;
  missionTime: number | null;
  phase: Phase;
  vehicles: VehicleSnapshot[];
  events: SimEvent[];
  /** Catch arms per pad: carriage height relative to home (m), opening (deg) and rail top (m). */
  towers: { offset: number; angle: number; top: number; broken: { L: boolean; R: boolean }; down: boolean; fallDir: V3; slew: number; qd: number; qdBroken: boolean }[];
  /** Ship's return phase after SECO (entry, belly-flop, ...), if it has started. */
  shipPhase: string | null;
  /** The player's controls as the sim sees them, and SAS's current aim (local ENU of the flown vehicle). */
  pilot: PilotCommand & { sasDirLocal: V3 | null };
  /** Catch guidance for a player flying the booster home (null otherwise). */
  catchGuide: CatchGuide | null;
  /** The maneuver node, with what's left of its burn. */
  node: (ManeuverNode & {
    /** Delta-v still to do, m/s, and its direction in the node vehicle's local ENU. */
    remaining: number;
    remainingLocal: V3;
    /** Burn duration at full thrust on the lit / all engines of the active stage, s. */
    burnTime: number;
  }) | null;
  /** Whether time warp can go on rails right now. */
  railsOk: boolean;
  /** The ship's return autopilot, if it's flying one. */
  shipReturn: {
    target: ReturnTarget;
    targetLatLon: { lat: number; lon: number };
    phase: string;
    status: string;
    burns: { label: string; t: number; dv: number }[];
    predicted: { lat: number; lon: number; missKm: number } | null;
    dvNeeded: number;
    dvAvailable: number;
    /** The player is flying the ship: the return waits until they hand it back. */
    paused: boolean;
    /** While paused and falling: hand back above this height (m above the surface) to make the approach. */
    handBackBy: number | null;
    /** The ship's height above the return's surface now, m. */
    height: number | null;
  } | null;
  /** An autopilot is coasting until this sim time (a hint: the player may warp). */
  waitUntil: number | null;
  /** Why the last return command was refused (and when, sim time), for the return panel. */
  returnNotice: { text: string; t: number } | null;
}

const padLat = PAD.latDeg * DEG;
const padLon = PAD.lonDeg * DEG;
const PAD_GROUND_ECEF = geodeticToEcef(padLat, padLon, PAD.groundAlt);
const ECEF_TO_ENU = ecefToEnuMatrix(padLat, padLon);

export class Simulation {
  t = 0;
  vehicles: Vehicle[] = [];
  events: SimEvent[] = [];
  mission!: Mission;
  aux = new Map<string, Aux>();
  /** Pad 1 and Pad 2 catch arms. */
  towers: TowerArms[] = [];
  /** The player's controls (KSP-style manual flight). */
  pilot = new Pilot();
  private eventCursor = 0;
  /** Structural / thermal state per vehicle id. */
  health = new Map<string, VehicleHealth>();
  /**
   * Sim time an autopilot is coasting until (its next burn / entry), or null: a hint for the
   * player, who may speed time up. Nothing warps on its own.
   */
  waitUntil: number | null = null;
  /** Why the last return command was refused, and when (sim time). */
  returnNotice: { text: string; t: number } | null = null;
  /** The planned maneuver: node, its burn vector (ECI, fixed when planned) and the delta-v done since. */
  node: { node: ManeuverNode; burn: V3; delivered: V3 } | null = null;
  /** The pad the stack stands on and launches from (0 = Pad 1, 1 = Pad 2); the booster comes home to it. */
  launchPad = 0;
  /** Or the booster lands on the Gulf here (pad ENU east / north, m), not at the tower. */
  boosterOcean: [number, number] | null = null;

  constructor(public env: Env = DEFAULT_ENV) {
    this.reset();
  }

  reset(): void {
    this.t = 0;
    this.events = [];
    this.eventCursor = 0;
    const stack = new Vehicle('stack', 'Starship V3', [
      { def: SUPER_HEAVY_V3, prop: SUPER_HEAVY_V3.propMass },
      { def: STARSHIP_V3, prop: STARSHIP_V3.propMass * MISSION.shipPropLoad },
    ]);
    this.vehicles = [stack];
    this.health.clear();
    this.gripped.clear();
    this.node = null;
    this.waitUntil = null;
    this.returnNotice = null;
    stack.caughtPad = this.launchPad;
    placeOnPad(stack, this.t, PAD.mountHeight, this.launchPad);
    // A stacked vehicle on the launch pad: its arms are parked high up the tower, clear of the launch.
    this.towers = [new TowerArms(), new TowerArms()];
    this.pilot.set({ target: 'stack', throttle: 1, engines: 0, pitch: 0, yaw: 0, roll: 0 });
    this.towers[this.launchPad].offset = this.towers[this.launchPad].targetOffset = ARMS.launchOffset;
    this.mission = new Mission(this);
    this.refreshAux();
  }

  launch(): void {
    this.mission.launch();
  }

  /**
   * Set the world up as a main-menu backdrop (from a fresh reset): the stack on the pad, one
   * counting down to launch, a ship in orbit or reentering, a ship in the chopsticks, or the
   * booster coming home to be caught.
   */
  scene(kind: MenuScene): void {
    this.launchPad = 0;
    this.reset();
    const pad1 = this.towers[0];
    const setArms = (arms: TowerArms, offset: number, angle: number) => {
      arms.offset = arms.targetOffset = offset;
      arms.angle = arms.targetAngle = angle;
    };
    switch (kind) {
      case 'pad':
        break;
      case 'liftoff':
        this.launch();
        break;
      case 'boosterCatch': {
        // A real flight, run ahead (1-2 s of computing) to Super Heavy's landing burn; the ship
        // is dropped after staging to save the time. It flies the rest (approach, catch) live.
        this.launch();
        for (let n = 0; n < 60000 && (this.mission.missionTime ?? -99) < CATCH_SCENE_T; n++) {
          this.step();
          if (this.find('ship') && this.find('booster')) this.vehicles = this.vehicles.filter((v) => v.id !== 'ship');
        }
        this.pilot.set({ target: 'booster' });
        break;
      }
      case 'orbit': {
        // Belly to the Earth, nose along the orbit, ~250 km up over the Texas Gulf coast: the
        // streamed aerial / Sentinel-2 imagery around Starbase is right below.
        const ship = new Vehicle('ship', 'Starship', [{ def: STARSHIP_V3, prop: STARSHIP_V3.propMass * 0.08 }]);
        const lat = ORBIT_SCENE.lat * DEG;
        const lon = ORBIT_SCENE.lon * DEG;
        const h = ORBIT_SCENE.alt;
        const r = ecefToEci(geodeticToEcef(lat, lon, h), this.t);
        const { e, n, u } = enuBasis(lat, lon);
        const heading = ORBIT_SCENE.heading * DEG;
        const along = normalize(ecefToEci(add(scale(e, Math.sin(heading)), scale(n, Math.cos(heading))), this.t));
        const up = normalize(ecefToEci(u, this.t));
        ship.r = r;
        ship.v = scale(along, Math.sqrt(MU / norm(r)));
        ship.q = qFromMat3(mat3FromColumns(along, scale(up, -1), cross(along, scale(up, -1))));
        ship.w = [0, 0, 0];
        ship.status = 'flight';
        this.vehicles = [ship];
        this.pilot.set({ target: 'ship' });
        break;
      }
      case 'reentry': {
        // Belly-first through the heating peak: 72 km up, 6.8 km/s, 60 deg angle of attack
        // (the tiled belly, body +y, into the flow), heading east over Mexico toward Starbase.
        const ship = new Vehicle('ship', 'Starship', [{ def: STARSHIP_V3, prop: STARSHIP_V3.propMass * 0.03 }]);
        const lat = 24.5 * DEG;
        const lon = -101 * DEG;
        const r = ecefToEci(geodeticToEcef(lat, lon, 72e3), this.t);
        const { e, n, u } = enuBasis(lat, lon);
        const heading = 75 * DEG;
        const east = ecefToEci(e, this.t);
        const north = ecefToEci(n, this.t);
        const up = normalize(ecefToEci(u, this.t));
        const level = normalize(add(scale(east, Math.sin(heading)), scale(north, Math.cos(heading))));
        const gamma = -1.2 * DEG;
        const vhat = normalize(add(scale(level, Math.cos(gamma)), scale(up, Math.sin(gamma))));
        // Air-relative speed 6.8 km/s: add the air's own motion (the Earth's rotation).
        ship.r = r;
        ship.v = add(scale(vhat, 6800), cross([0, 0, OMEGA_E], r));
        const a = 60 * DEG;
        const x = normalize(add(scale(vhat, Math.cos(a)), scale(up, Math.sin(a))));
        const y = normalize(add(scale(vhat, Math.sin(a)), scale(up, -Math.cos(a))));
        ship.q = qFromMat3(mat3FromColumns(x, y, cross(x, y)));
        ship.w = [0, 0, 0];
        ship.status = 'flight';
        this.vehicles = [ship];
        this.pilot.set({ target: 'ship' });
        // (Long since launched: heating and structural limits apply.)
        this.mission.liftoffT = this.t - 3000;
        break;
      }
      case 'shipCatch': {
        // The ship home from 40 km (the saved state, turned with the Earth to now), run ahead
        // (about two seconds of computing) to just before its flip: the flip, the landing burn
        // and the catch by Pad 1's chopsticks play live.
        const c = SHIP_HOME_40KM;
        const turn = OMEGA_E * (this.t - c.t);
        const rz = (x: V3): V3 => [x[0] * Math.cos(turn) - x[1] * Math.sin(turn), x[0] * Math.sin(turn) + x[1] * Math.cos(turn), x[2]];
        const ship = new Vehicle('ship', 'Starship', [{ def: STARSHIP_V3, prop: c.prop }]);
        ship.r = rz(c.r);
        ship.v = rz(c.v);
        ship.q = qmul([Math.cos(turn / 2), 0, 0, Math.sin(turn / 2)], c.q);
        ship.w = [...c.w];
        ship.surfaceAngles = [...c.surfaces];
        ship.status = 'flight';
        this.vehicles = [ship];
        this.refreshAux();
        // (Long since launched and past its engine cutoff: coasting home.)
        this.mission.liftoffT = this.t - 4000;
        this.mission.phase = 'coast';
        this.commandReturn({ kind: 'tower', pad: 0 });
        const t0 = this.t;
        for (let n = 0; n < 60000 && this.t - t0 < SHIP_CATCH_SCENE_T && this.mission.shipReturn; n++) this.step();
        this.pilot.set({ target: 'ship' });
        break;
      }
      case 'shipCaught': {
        // Just caught: the ship on Pad 1's arms at the catch height, no booster under it.
        const { ship } = this.separate();
        this.vehicles = [ship];
        setArms(pad1, 0, 0);
        this.grab(ship, 0, SHIP_CATCH_PIN);
        this.pilot.set({ target: 'ship' });
        break;
      }
    }
    // Hanging vehicles: in place on their arms now.
    for (const v of this.vehicles) if (v.status === 'caught') this.hang(v, this.t);
    this.refreshAux();
    this.events = [];
    this.eventCursor = 0;
  }

  /**
   * Run a flight ahead to where a mission starts (a second or two of computing). The stage the
   * mission isn't about is dropped once they separate (it only costs time).
   */
  startAt(start: MissionStart): void {
    if (start === 'pad') return;
    this.launch();
    const tm = () => this.mission.missionTime ?? -99;
    const drop = (id: string) => {
      if (this.find('ship') && this.find('booster')) this.vehicles = this.vehicles.filter((v) => v.id !== id);
    };
    let n = 0;
    const MAX = 200_000;
    if (start === 'separation') {
      while (n++ < MAX && !(this.find('booster') && this.find('ship'))) this.step();
      for (let i = 0; i < 100; i++) this.step();
    } else if (start === 'boosterLanding') {
      // Falling back engines-first, ~20 km up, ~25 s before the landing burn would light.
      while (n++ < MAX && tm() < 350) {
        this.step();
        if (this.mission.phase === 'shipburn') drop('ship');
      }
    } else if (start === 'entry') {
      // Up to engine cutoff, then coast (on rails above the air) down to ~115 km.
      while (n++ < MAX && !this.events.some((e) => /^SECO/.test(e.text))) {
        this.step();
        // (Once hot staging is over: the sequence needs the booster until then.)
        if (this.mission.phase === 'shipburn') drop('booster');
      }
      const ship = () => this.find('ship');
      const falling = () => {
        const a = this.aux.get('ship');
        return !!a && a.geo.h < 115e3 && dot(a.vAir, normalize(ship()!.r)) < 0;
      };
      while (n++ < MAX && ship()?.status === 'flight' && !falling()) {
        if (this.railsAllowed()) this.railsStep(20);
        else this.step();
      }
    }
    this.events = [];
    this.eventCursor = 0;
  }

  log(text: string): void {
    this.events.push({ t: this.t, missionTime: this.mission?.missionTime ?? null, text });
  }

  find(id: string): Vehicle | undefined {
    return this.vehicles.find((v) => v.id === id);
  }

  private refreshAux(): void {
    this.aux.clear();
    for (const v of this.vehicles) this.aux.set(v.id, currentAux(v, this.t, this.env));
  }

  /**
   * Player control of a tower's arms: lift +1 raises / -1 lowers / 0 stops the carriage,
   * swing +1 opens / -1 closes / 0 stops the arms (null leaves that motion alone).
   */
  commandArms(pad: number, lift: -1 | 0 | 1 | null, swing: -1 | 0 | 1 | null, slew: -1 | 0 | 1 | null = null): void {
    const arms = this.towers[pad];
    if (!arms) return;
    if (lift !== null) {
      if (lift === 0) arms.hold('lift');
      else arms.command({ offset: lift > 0 ? ARMS.maxOffset : ARMS.minOffset });
    }
    if (swing !== null) {
      if (swing === 0) arms.hold('swing');
      else arms.command({ angle: swing > 0 ? ARMS.maxOpenDeg : 0 });
    }
    if (slew !== null) {
      if (slew === 0) arms.hold('slew');
      else arms.command({ slew: slew * ARMS.maxSlewDeg });
    }
  }

  step(dt: number = DT): void {
    this.refreshAux();
    this.constrainArms();
    for (const t of this.towers) t.update(dt);
    this.pilot.maneuverDir = this.maneuverRemaining()?.dir ?? null;
    const booster = this.find('booster');
    const br = this.mission.boosterReturn;
    this.pilot.targetDir = booster && br && this.pilot.flies(booster) && this.aux.get('booster') ? br.targetHold(booster, this.aux.get('booster')!, dt) : null;
    this.mission.update(dt);
    this.trackBurn(dt);

    // (Standing vehicles first: one hanging above looks at where they are at the step's end.)
    const order = [...this.vehicles].sort((a, b) => Number(a.status === 'caught') - Number(b.status === 'caught'));
    for (const v of order) {
      if (v.status === 'destroyed') continue;
      // Engine spool: fast shutdown, ~1 s startup; deep-throttle floor while running.
      for (const e of v.engines) {
        const prop = v.stages[e.stage].prop;
        let cmd = e.failed || prop <= 0 ? 0 : e.throttleCmd;
        if (cmd > 0) cmd = clamp(cmd, e.place.type.minThrottle, 1);
        const rate = cmd > e.throttle ? 1.0 : 4.0;
        e.throttle += clamp(cmd - e.throttle, -rate * dt, rate * dt);
      }
      // Standing on something (not held by the arms): an arm swung, lifted or lowered into it
      // from one side tips it over its base edge.
      if ((v.status === 'held' || v.status === 'landed') && !this.toppling.has(v.id)) {
        // Closed on it at its lifting points and lifting: the arms take it (off the stack, for a ship).
        if (this.pickUp(v)) continue;
        const push = this.armPush(v, this.t + dt);
        if (push) this.startTopple(v, push, this.t + dt);
      }
      if (this.toppling.has(v.id)) {
        this.topple(v, dt);
      } else if (v.status === 'held') {
        for (const e of v.engines) v.stages[e.stage].prop -= engineMassFlow(e.place.type, e.throttle) * dt;
        placeOnPad(v, this.t + dt, PAD.mountHeight, v.caughtPad);
      } else if (v.status === 'caught' && this.armsLetGo(v)) {
        // Let go: a ship set down on a booster standing on the mount is stacked again.
        const under = this.standingUnder(v, this.t + dt);
        if (v.id === 'ship' && under?.id === 'booster' && this.restack(under, v, this.t + dt)) continue;
        this.release(v);
      } else if (v.status === 'caught') {
        // Hanging on the arms: engines shut down.
        for (const e of v.engines) e.throttleCmd = 0;
        this.hang(v, this.t + dt);
      } else if (v.status === 'landed') {
        restOnEarth(v, this.t, dt);
      } else {
        const aux = rk4Step(v, this.t, dt, this.env);
        const sinceLiftoff = this.mission.liftoffT === null ? 0 : this.t - this.mission.liftoffT;
        let health = this.health.get(v.id);
        if (!health) this.health.set(v.id, (health = newHealth()));
        // (The state is now at the end of the step: the pad frame, turning with the Earth, has
        // moved ~4.6 m east in 0.01 s, so convert at that time.)
        const tEnd = this.t + dt;
        this.holdInGrip(v, tEnd);
        const hit = deepestContact(this.hull(v, aux, tEnd), this.towerStates());
        if (hit && this.collide(v, hit, health, tEnd)) continue;
        const broke = sinceLiftoff > 5 ? checkLimits(v, aux, health, dt) : null;
        if (broke) {
          this.destroy(v, `${v.name} lost: ${broke}`);
          continue;
        }
        // Ground or sea contact: gentle and upright is a landing, anything else a crash.
        const up = normalize(v.r);
        const axis = qrot(v.q, [1, 0, 0]);
        const baseH = aux.geo.h - (aux.mp.xcg - v.extent[0]) * dot(axis, up);
        const nearPad = downrange(v.r, tEnd) < 4000;
        // The launch mounts stand 25 m proud of the pad; the transport stands a few metres.
        const surface = nearPad ? PAD.groundAlt + surfaceUnder(eciToPad(v.r, tEnd)) : 0;
        if (baseH < surface && sinceLiftoff > 5) {
          const vz = -dot(aux.vAir, up);
          const vh = norm(sub(aux.vAir, scale(up, -vz)));
          const km = (downrange(v.r, tEnd) / 1000).toFixed(0);
          if (vz < 8 && vh < 6 && dot(axis, up) > Math.cos(15 * DEG)) {
            for (const e of v.engines) e.throttleCmd = 0;
            v.status = 'landed';
            this.log(`${v.name} ${nearPad ? 'touchdown' : 'splashdown'} at ${vz.toFixed(1)} m/s (${km} km downrange)`);
          } else {
            this.destroy(v, `${v.name} impact ${km} km downrange at ${(norm(aux.vAir) * 3.6).toFixed(0)} km/h`);
          }
        }
      }
    }
    this.t += dt;
  }

  /** Plan (or clear) the maneuver node: the burn vector is fixed from the orbit at the node. */
  setNode(node: ManeuverNode | null): void {
    const v = node && this.find(node.vehicle);
    if (!node || !v || v.status !== 'flight') {
      this.node = null;
      return;
    }
    const mass = (this.aux.get(v.id) ?? currentAux(v, this.t, this.env)).mp.mass;
    const at = node.t > this.t ? propagate(v.r, v.v, this.t, node.t, { dragArea: 0 }, mass) : { r: v.r, v: v.v };
    const f = orbitalFrame(at.r, at.v);
    const burn = add(add(scale(f.pro, node.dv[0]), scale(f.nrm, node.dv[1])), scale(f.rad, node.dv[2]));
    this.node = { node, burn, delivered: [0, 0, 0] };
  }

  /** Delta-v still to do on the node (ECI vector, magnitude, unit direction), or null. */
  private maneuverRemaining(): { vec: V3; mag: number; dir: V3 } | null {
    if (!this.node) return null;
    const vec = sub(this.node.burn, this.node.delivered);
    const mag = norm(vec);
    return { vec, mag, dir: mag > 1e-6 ? scale(vec, 1 / mag) : normalize(this.node.burn) };
  }

  /** Count the node vehicle's thrust toward the planned burn; clear the node once it's done. */
  private trackBurn(dt: number): void {
    if (!this.node) return;
    const v = this.find(this.node.node.vehicle);
    const aux = v && this.aux.get(v.id);
    if (!v || !aux || v.status !== 'flight') {
      this.node = null;
      return;
    }
    if (aux.thrust <= 0) return;
    const a = scale(qrot(v.q, [1, 0, 0]), (aux.thrust / aux.mp.mass) * dt);
    this.node.delivered = add(this.node.delivered, a);
    const rem = this.maneuverRemaining()!;
    // Done: within 0.5 m/s, or overshot (what's left points back against the plan).
    if (rem.mag < 0.5 || dot(rem.vec, this.node.burn) < 0) {
      this.log(`Maneuver complete (${rem.mag.toFixed(1)} m/s residual)`);
      this.node = null;
    }
  }

  /**
   * Send the ship home under autopilot (tower or ocean), or cancel (null). A tower target with
   * pad -1 picks a free tower (not holding a vehicle, not wrecked).
   */
  commandReturn(target: ReturnTarget | null): void {
    const ship = this.find('ship');
    const m = this.mission;
    m.shipReturn?.cancel();
    m.shipReturn = null;
    this.returnNotice = null;
    if (!target) {
      this.log('Return cancelled');
      return;
    }
    const refuse = (text: string) => {
      this.log(text);
      this.returnNotice = { text, t: this.t };
    };
    if (!ship || ship.status !== 'flight' || m.phase !== 'coast') {
      refuse("Can't return yet: after the ship's engine cutoff (SECO)");
      return;
    }
    if (target.kind === 'tower') {
      const free = (p: number) => !this.towers[p].disabled && !this.vehicles.some((v) => v.status === 'caught' && v.caughtPad === p);
      const pad = target.pad >= 0 && free(target.pad) ? target.pad : [0, 1].find(free);
      if (pad === undefined) {
        refuse("Can't return to a tower: both are holding a vehicle or wrecked");
        return;
      }
      target = { kind: 'tower', pad };
    }
    this.pilot.set({ manual: false });
    m.shipReturn = new ShipReturn(this, ship, target, (text) => this.log(text));
    if (m.shipReturn.phase === 'lost') {
      this.returnNotice = { text: m.shipReturn.status, t: this.t };
      m.shipReturn = null;
    }
  }

  /** Whether time warp may go on rails: everything in flight coasting above the atmosphere. */
  railsAllowed(): boolean {
    if (this.mission.phase === 'countdown' || this.mission.phase === 'ascent' || this.mission.phase === 'hotstaging') return false;
    // A burn coming up: off rails in time to turn to it (on rails the attitude is frozen).
    const until = this.railsUntil();
    if (until !== null && this.t >= until - 0.01) return false;
    for (const v of this.vehicles) {
      if (v.status !== 'flight') continue;
      const aux = this.aux.get(v.id);
      if (!aux || aux.geo.h < RAILS_ALT || aux.thrust > 0 || v.engines.some((e) => e.throttleCmd > 0)) return false;
    }
    return true;
  }

  /**
   * On-rails time warp: coast everything in flight along its orbit (gravity only, attitude frozen
   * inertially), keep landed / caught vehicles with the Earth. Stops early (returning the time
   * actually advanced) if something would dip below the rails altitude.
   */
  /**
   * Sim time rails must stop at: a minute and a half before a planned burn starts (the maneuver
   * node, or the return autopilot's closed-loop entry burn window), or null.
   */
  private railsUntil(): number | null {
    let until: number | null = null;
    const snap = this.node && this.nodeSnapshot();
    if (this.node) {
      const half = snap && Number.isFinite(snap.burnTime) ? snap.burnTime / 2 : 60;
      until = this.node.node.t - half - RAILS_BURN_LEAD;
    }
    const r = this.mission.shipReturn;
    if (r && r.phase === 'burn' && r.plan.burns[r.burnIndexNow]?.label === 'entry burn') until = Math.min(until ?? Infinity, this.t);
    return until;
  }

  railsStep(dt: number): number {
    // (Never past the point a burn needs the ship off rails.)
    const until = this.railsUntil();
    if (until !== null) dt = Math.max(0, Math.min(dt, until - this.t));
    const chunk = 10;
    let done = 0;
    while (done < dt - 1e-9) {
      const h = Math.min(chunk, dt - done);
      for (const v of this.vehicles) {
        if (v.status === 'flight') {
          const aux = this.aux.get(v.id) ?? currentAux(v, this.t, this.env);
          const next = propagate(v.r, v.v, this.t, this.t + h, { dragArea: 0 }, aux.mp.mass, 10);
          v.r = next.r;
          v.v = next.v;
          v.w = [0, 0, 0];
        } else if (v.status === 'caught') {
          for (const e of v.engines) e.throttleCmd = 0;
          this.hang(v, this.t + h);
        } else if (v.status === 'landed') {
          restOnEarth(v, this.t, h);
        } else if (v.status === 'held') {
          placeOnPad(v, this.t + h, PAD.mountHeight, v.caughtPad);
        }
      }
      for (const t of this.towers) t.update(h);
      this.t += h;
      done += h;
      this.refreshAux();
      if (!this.railsAllowed()) break;
    }
    return done;
  }

  /** A vehicle's hull as a cylinder, base to top, in the pad frame. */
  /** t: the time the vehicle's state is at (the step's end, once it has been integrated). */
  private hull(v: Vehicle, aux: Aux, t = this.t): Cylinder {
    const axis = eciDirToPad(qrot(v.q, [1, 0, 0]), t);
    const cg = eciToPad(v.r, t);
    return cylinder(add(cg, scale(axis, v.extent[0] - aux.mp.xcg)), axis, v.extent[1] - v.extent[0]);
  }

  /** Vehicles being tipped over (id -> the tip about their base edge). */
  private toppling = new Map<string, Topple>();

  /**
   * An arm pressing into a standing vehicle from one side (pad ENU contact), or null. Both arms
   * on it from opposite sides is a squeeze (the arms stop there: constrainArms).
   */
  private armPush(v: Vehicle, t: number): Contact | null {
    const aux = this.aux.get(v.id);
    if (!aux || downrange(v.r, t) > 2000) return null;
    const cyl = this.hull(v, aux, t);
    let push: Contact | null = null;
    this.towerStates().forEach((st, pad) => {
      const l = armContact(pad, 'L', st, cyl);
      const r = armContact(pad, 'R', st, cyl);
      if (l && r && dot(l.normal, r.normal) < 0) return;
      for (const c of [l, r]) if (c && c.depth > TOPPLE_PUSH_DEPTH && (!push || c.depth > push.depth)) push = c;
    });
    return push;
  }

  /** Start tipping a standing vehicle over the edge of its base, away from what pushed it. */
  private startTopple(v: Vehicle, push: Contact, t: number): void {
    const aux = this.aux.get(v.id) ?? currentAux(v, t, this.env);
    const cyl = this.hull(v, aux, t);
    const d: V3 = normalize([push.normal[0], push.normal[1], 0]);
    const pivot = add(cyl.a, scale(d, cyl.r));
    const cg = eciToPad(v.r, t);
    this.toppling.set(v.id, {
      pivot,
      dir: d,
      angle: 0,
      rate: 0,
      cgRel: sub(cg, pivot),
      axes: [0, 1, 2].map((i) => eciDirToPad(qrot(v.q, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]), t)) as [V3, V3, V3],
      length: v.extent[1] - v.extent[0],
      hcg: aux.mp.xcg - v.extent[0],
      radius: cyl.r,
    });
    const what = push.what === 'tower' ? 'tower' : 'chopsticks';
    this.log(`${v.name} is being pushed over by the Pad ${push.pad + 1} ${what}`);
  }

  /**
   * One step of a vehicle tipping about its base edge: any arm still pressing into it pushes it
   * further; gravity rocks it back if its centre of mass is still inside the edge, or brings it
   * down once past. When it hits the ground it's destroyed.
   */
  private topple(v: Vehicle, dt: number): void {
    const tp = this.toppling.get(v.id)!;
    const t = this.t + dt;
    const g = 9.81;
    // About the edge: rigid body (slender cylinder), CG hcg up and radius in from the pivot.
    const inertia = tp.hcg * tp.hcg + tp.radius * tp.radius + (tp.length * tp.length) / 12;
    const alpha = (g * (tp.hcg * Math.sin(tp.angle) - tp.radius * Math.cos(tp.angle))) / inertia;
    tp.rate += alpha * dt;
    tp.angle += tp.rate * dt;
    if (tp.angle <= 0 && tp.rate <= 0) {
      // Rocked back onto its base.
      tp.angle = 0;
      tp.rate = 0;
    }
    this.poseTopple(v, tp, t);
    // Still being pushed: tip it until the arm no longer overlaps it.
    const aux = currentAux(v, t, this.env);
    const cyl = this.hull(v, aux, t);
    for (const [pad, st] of this.towerStates().entries()) {
      for (const side of ['L', 'R'] as const) {
        const c = armContact(pad, side, st, cyl);
        // (Only an arm behind it pushes it on: one it falls against doesn't throw it further.)
        if (!c || dot(c.normal, tp.dir) < 0.3) continue;
        // It can go over no faster than the arm moves (a couple of m/s at most).
        const h = Math.max(5, c.point[2] - tp.pivot[2]);
        const step = Math.min(c.depth, ARM_PUSH_SPEED * dt) / h;
        tp.angle += step;
        tp.rate = Math.max(tp.rate, step / dt);
      }
    }
    this.poseTopple(v, tp, t);
    // Settled back upright with nothing pushing: it's standing again.
    if (tp.angle === 0 && tp.rate === 0) {
      this.toppling.delete(v.id);
      v.rest = null;
      return;
    }
    // The far end reaches the ground: it's down.
    const top = add(tp.pivot, rotateAbout(add(scale(tp.dir, -tp.radius), [0, 0, tp.length]), tp.dir, tp.angle));
    if (top[2] <= 2 || tp.angle > Math.PI / 2 + 0.3) {
      this.toppling.delete(v.id);
      this.destroy(v, `${v.name} toppled over and was destroyed`);
    }
  }

  /** Place a toppling vehicle: its standing pose turned by the tip angle about its base edge. */
  private poseTopple(v: Vehicle, tp: Topple, t: number): void {
    const cg = add(tp.pivot, rotateAbout(tp.cgRel, tp.dir, tp.angle));
    v.r = padToEci(cg, t);
    v.v = cross([0, 0, OMEGA_E], v.r);
    const ax = tp.axes.map((a) => padDirToEci(rotateAbout(a, tp.dir, tp.angle), t));
    v.q = qFromMat3(mat3FromColumns(ax[0], ax[1], ax[2]));
    v.w = qrotInv(v.q, [0, 0, OMEGA_E]);
  }

  private towerStates(): TowerState[] {
    return this.towers.map((a) => ({ offset: a.offset, angle: a.angle, broken: a.broken, down: a.down, slew: a.slew, qd: a.qd, qdBroken: a.qdBroken }));
  }

  /**
   * The chopsticks can't close through a vehicle. Closing on a vehicle in flight, the first arm
   * to touch pushes it toward the other (collide() moves it); once both arms press on it, or
   * either presses on one that's clamped or hanging, they stop: that's "closed" for a catch.
   */
  private constrainArms(): void {
    const hulls = this.vehicles
      .filter((v) => v.status !== 'destroyed')
      .map((v) => ({ v, cyl: this.hull(v, this.aux.get(v.id) ?? currentAux(v, this.t, this.env)) }));
    this.captured.clear();
    this.towers.forEach((arms, pad) => {
      arms.contact = false;
      arms.blocked = false;
      arms.touching = false;
      if (arms.disabled || !hulls.length) return;
      const state = this.towerStates()[pad];
      // A little further closed than now: would that go into a hull?
      const probe = Math.max(0, arms.angle - 0.3);
      let left = false;
      let right = false;
      let fixed = false;
      for (const h of hulls) {
        // Chopsticks centre what they close on: a vehicle within the capture radius at arm
        // height is held as if centred (and isn't knocked about by them).
        const grip = this.gripped.get(h.v.id) === pad;
        if (grip && (h.v.status !== 'flight' || arms.targetAngle > arms.angle + 0.01)) this.gripped.delete(h.v.id);
        const centred =
          h.v.status === 'flight' && (arms.targetAngle < arms.angle || this.gripped.get(h.v.id) === pad)
            ? this.captureCentred(pad, h.cyl, arms.top, this.gripped.get(h.v.id) === pad)
            : null;
        if (centred) this.captured.add(`${h.v.id}:${pad}`);
        const cyl = centred ?? h.cyl;
        const l = armContact(pad, 'L', state, cyl, probe);
        const r = armContact(pad, 'R', state, cyl, probe);
        left ||= !!l;
        right ||= !!r;
        if ((l || r) && h.v.status !== 'flight') fixed = true;
      }
      arms.contact = left && right;
      arms.touching = left || right;
      arms.blocked = arms.contact || fixed;
      // Both arms on a vehicle they're centring: they hold it (sideways) from here.
      if (arms.contact) for (const h of hulls) if (this.captured.has(`${h.v.id}:${pad}`)) this.gripped.set(h.v.id, pad);
    });
  }

  /** Vehicles being held by a pad's closing arms this step (`id:pad`). */
  private captured = new Set<string>();
  /** Vehicles gripped by closed arms (id -> pad): held on the arms' centreline until caught or released. */
  private gripped = new Map<string, number>();

  /**
   * Closed arms hold what they grip: keep the hull (at arm height) on the catch point and stop
   * its sideways motion; it can still move up and down (settling onto the rails).
   */
  private holdInGrip(v: Vehicle, t: number): void {
    const pad = this.gripped.get(v.id);
    if (pad === undefined) return;
    const aux = this.aux.get(v.id) ?? currentAux(v, this.t, this.env);
    const cyl = this.hull(v, aux, t);
    const d = sub(cyl.b, cyl.a);
    const top = this.towers[pad].top;
    const k = Math.abs(d[2]) > 1e-6 ? clamp((top - 5 - cyl.a[2]) / d[2], 0, 1) : 0;
    const p = add(cyl.a, scale(d, k));
    const [me, mn] = MOUNTS[pad];
    // Eased: the arms guide it in (up to ~2 m/s) and damp its sideways motion.
    const dx = me - p[0];
    const dy = mn - p[1];
    const d2 = Math.hypot(dx, dy);
    const step = Math.min(d2, 2 * DT);
    if (d2 > 1e-6) v.r = add(v.r, padDirToEci([(dx / d2) * step, (dy / d2) * step, 0], t));
    const vel = eciVelToPad(v.r, v.v, t);
    v.v = sub(v.v, padDirToEci([vel[0] * 0.2, vel[1] * 0.2, 0], t));
  }

  /**
   * If the hull, at the arms' height, is within the capture radius of the catch point: the same
   * hull moved onto the centreline (what the closing arms will do to it). Else null.
   */
  private captureCentred(pad: number, cyl: Cylinder, top: number, gripped = false): Cylinder | null {
    const [me, mn] = MOUNTS[pad];
    const d = sub(cyl.b, cyl.a);
    if (Math.abs(d[2]) < 1e-6) return null;
    const k = (top - 5 - cyl.a[2]) / d[2];
    if (k < 0 || k > 1) return null;
    const p = add(cyl.a, scale(d, k));
    const off: V3 = [me - p[0], mn - p[1], 0];
    if (!gripped && Math.hypot(off[0], off[1]) > CAPTURE_RADIUS) return null;
    return { a: add(cyl.a, off), b: add(cyl.b, off), r: cyl.r };
  }

  /**
   * A flying vehicle touching a tower or arm. Fast (into the structure): both are wrecked.
   * Gentle: it's pushed back out, the motion into the structure stops, and the knock adds
   * structural damage. Returns true if the vehicle was destroyed.
   */
  private collide(v: Vehicle, hit: Contact, health: VehicleHealth, t: number): boolean {
    const arm = hit.what === 'armL' || hit.what === 'armR';
    // Held by closing arms (see constrainArms): not a knock.
    if (arm && this.captured.has(`${v.id}:${hit.pad}`)) return false;
    const velPad = eciVelToPad(v.r, v.v, t);
    // A vehicle between the arms is squeezed square to their centreline, toward the other arm
    // (the real arms are straight where they meet it; this model's curled claw tips would
    // otherwise push it out through the open end of the V).
    if (arm) {
      const [me, mn] = MOUNTS[hit.pad];
      const [te, tn] = TOWERS[hit.pad];
      const cl = normalize([me - te, mn - tn, 0]);
      const side: V3 = [-cl[1], cl[0], 0];
      const cg = eciToPad(v.r, t);
      const vehLat = (cg[0] - me) * side[0] + (cg[1] - mn) * side[1];
      const armLat = (hit.point[0] - me) * side[0] + (hit.point[1] - mn) * side[1];
      if (Math.abs(vehLat) < Math.abs(armLat) && Math.abs(armLat) < 12) hit = { ...hit, normal: scale(side, armLat > 0 ? -1 : 1) };
    }
    const vn = -dot(velPad, hit.normal);
    const arms = this.towers[hit.pad];
    const pad = hit.pad === 0 ? 'Pad 1' : 'Pad 2';
    const part = hit.what === 'tower' ? `${pad} tower` : hit.what === 'qd' ? `${pad} ship QD arm` : `${pad} chopsticks`;
    const crash = hit.what === 'tower' ? CRASH_SPEED.tower : CRASH_SPEED.arm;
    // The QD arm is a light swing arm: a vehicle leaning on it bends it out of the way (and
    // takes a knock); only a fast hit also wrecks the vehicle.
    if (hit.what === 'qd' && vn > QD_BREAK_SPEED && vn <= CRASH_SPEED.qd) {
      this.wreck(hit, velPad);
      health.damage += (vn / CRASH_SPEED.qd) ** 2;
      // It soaks up some of the motion into it as it goes.
      v.v = add(v.v, padDirToEci(scale(hit.normal, 0.4 * vn), t));
      this.log(`${v.name} struck the ${part} (${vn.toFixed(1)} m/s, damage ${Math.round(Math.min(1, health.damage) * 100)}%)`);
      if (health.damage >= 1) {
        this.destroy(v, `${v.name} broke up against the ${part}`);
        return true;
      }
      return false;
    }
    if (hit.what === 'qd' && vn > CRASH_SPEED.qd) {
      this.destroy(v, `${v.name} hit the ${part} at ${vn.toFixed(1)} m/s`);
      this.wreck(hit, velPad);
      return true;
    }
    if (hit.what !== 'qd' && vn > crash) {
      this.destroy(v, `${v.name} hit the ${part} at ${vn.toFixed(1)} m/s`);
      this.wreck(hit, velPad);
      return true;
    }
    // Push out and stop the motion into the structure.
    v.r = add(v.r, padDirToEci(scale(hit.normal, hit.depth), t));
    if (vn > 0) v.v = add(v.v, padDirToEci(scale(hit.normal, vn), t));
    if (vn > 0.5) {
      health.damage += (vn / crash) ** 2;
      if (vn > 1) this.log(`${v.name} struck the ${part} (${vn.toFixed(1)} m/s, damage ${Math.round(Math.min(1, health.damage) * 100)}%)`);
      if (health.damage >= 1) {
        this.destroy(v, `${v.name} broke up against the ${part}`);
        this.wreck(hit, velPad);
        return true;
      }
    }
    void arms;
    return false;
  }

  /** A structure takes a destructive hit. */
  private wreck(hit: Contact, velPad: V3): void {
    const arms = this.towers[hit.pad];
    const pad = hit.pad === 0 ? 'Pad 1' : 'Pad 2';
    if (hit.what === 'qd') {
      if (!arms.qdBroken) this.log(`${pad} ship QD arm wrecked`);
      arms.qdBroken = true;
      return;
    }
    if (hit.what === 'tower') {
      if (!arms.down) this.log(`${pad} tower destroyed`);
      arms.down = true;
      // It goes over the way it was pushed.
      const h = Math.hypot(velPad[0], velPad[1]);
      arms.fallDir = h > 0.1 ? [velPad[0] / h, velPad[1] / h, 0] : [-hit.normal[0], -hit.normal[1], 0];
    } else {
      const side = hit.what === 'armL' ? 'L' : 'R';
      if (!arms.broken[side]) this.log(`${pad} chopstick wrecked`);
      arms.broken[side] = true;
    }
    arms.contact = false;
    // Anything hanging on this tower's arms comes down with them.
    for (const c of this.vehicles) if (c.status === 'caught' && c.caughtPad === hit.pad) this.release(c);
  }

  /**
   * A vehicle hangs on a tower's arms only while they're closed on it: commanded open (or
   * stopped) and no longer pressing on the hull, or wrecked, they let it go.
   */
  private armsLetGo(v: Vehicle): boolean {
    const arms = this.towers[v.caughtPad];
    if (arms.disabled) return true;
    const closing = arms.targetAngle < arms.angle - 0.01;
    return !arms.contact && !closing;
  }

  /**
   * A vehicle hanging on a tower's arms goes where they go: up and down with the carriage, and
   * round the tower as they swing. The carriage can lower it only until it sits on whatever is
   * under it (the launch mount, a transport stand, the ground); opening the arms then leaves it
   * standing there.
   */
  private hang(v: Vehicle, t: number): void {
    const arms = this.towers[v.caughtPad];
    const [e, n] = catchPoint(v.caughtPad, arms.slew);
    // What it would come down on: a vehicle standing there (a booster, for restacking a ship), or
    // the mount / stand / ground.
    const under = this.standingUnder(v, t);
    const surface = under ? this.standingTop(under, t) : surfaceUnder([e, n, 0]);
    arms.floor = Math.max(ARMS.minOffset, surface + v.catchPin - ARMS.homeTop);
    placeOnPad(v, t, arms.top - v.catchPin, v.caughtPad, arms.slew);
  }

  /**
   * Standing vehicles the arms can lift, closed on them at their lifting points: a booster or
   * ship by its catch fittings; a stack by its ship's (lifting the ship off the booster).
   * Returns true if it was picked up (or split off).
   */
  private pickUp(v: Vehicle): boolean {
    const lift = liftPoint(v);
    const aux = this.aux.get(v.id);
    if (lift === null || !aux) return false;
    const cyl = this.hull(v, aux);
    return this.towers.some((arms, pad) => {
      if (arms.disabled || !arms.contact || arms.targetOffset <= arms.offset + 0.01) return false;
      if (Math.abs(arms.top - (cyl.a[2] + lift)) > 1.0) return false;
      const [e, n] = catchPoint(pad, arms.slew);
      if (Math.hypot(cyl.a[0] - e, cyl.a[1] - n) > 1.5) return false;
      if (v.id === 'stack') {
        const { booster, ship } = this.separate();
        booster.status = 'held';
        booster.caughtPad = v.caughtPad;
        placeOnPad(booster, this.t, PAD.mountHeight, booster.caughtPad);
        this.grab(ship, pad, SHIP_CATCH_PIN);
        this.log(`Pad ${pad + 1} chopsticks lifting Starship off Super Heavy`);
      } else {
        this.grab(v, pad, lift);
        this.log(`Pad ${pad + 1} chopsticks lifting ${v.name}`);
      }
      return true;
    });
  }

  private grab(v: Vehicle, pad: number, pin: number): void {
    v.status = 'caught';
    v.caughtPad = pad;
    v.catchPin = pin;
    v.rest = null;
    for (const e of v.engines) e.throttleCmd = 0;
  }

  /**
   * A vehicle standing (on the mount, a stand, the ground) right under a hanging one, if any.
   * t: the time the standing vehicles' states are at (the step's end: they're moved first).
   */
  private standingUnder(v: Vehicle, t: number): Vehicle | undefined {
    const [e, n] = catchPoint(v.caughtPad, this.towers[v.caughtPad].slew);
    return this.vehicles.find((o) => {
      if (o === v || (o.status !== 'held' && o.status !== 'landed') || this.toppling.has(o.id)) return false;
      const aux = this.aux.get(o.id);
      if (!aux) return false;
      const c = this.hull(o, aux, t);
      return Math.hypot(c.b[0] - e, c.b[1] - n) < 1.5 && c.b[2] > c.a[2];
    });
  }

  /** Height of a standing vehicle's top above the pad ground, m. */
  private standingTop(o: Vehicle, t: number): number {
    return this.hull(o, this.aux.get(o.id) ?? currentAux(o, this.t, this.env), t).b[2];
  }

  /**
   * A ship let go of standing on a booster that's on Pad 1's launch mount: they're one stacked
   * vehicle again (ready to launch). False if it isn't sitting on it.
   */
  private restack(booster: Vehicle, ship: Vehicle, t: number): boolean {
    // (The ship hasn't moved yet this step; the booster, standing, is already at its end, t.)
    const aux = this.aux.get(ship.id) ?? currentAux(ship, this.t, this.env);
    const base = this.hull(ship, aux).a[2];
    const bAux = this.aux.get(booster.id) ?? currentAux(booster, this.t, this.env);
    const bc = this.hull(booster, bAux, t);
    const [me, mn] = MOUNTS[booster.caughtPad];
    const onMount = Math.hypot(bc.a[0] - me, bc.a[1] - mn) < 1.5 && Math.abs(bc.a[2] - PAD.mountHeight) < 0.5;
    if (!onMount || Math.abs(base - bc.b[2]) > 0.3) return false;
    const stack = new Vehicle('stack', 'Starship V3', [booster.stages[0], ship.stages[0]]);
    carryAngles(booster, stack);
    carryAngles(ship, stack);
    this.vehicles = this.vehicles.filter((o) => o !== booster && o !== ship).concat([stack]);
    stack.caughtPad = booster.caughtPad;
    placeOnPad(stack, t, PAD.mountHeight, stack.caughtPad);
    stack.status = 'held';
    if (this.pilot.cmd.target === 'ship' || this.pilot.cmd.target === 'booster') this.pilot.set({ target: 'stack' });
    this.refreshAux();
    this.log('Starship stacked on Super Heavy');
    return true;
  }

  /** Drop a caught vehicle: it's in free fall again (and will meet the launch mount). */
  private release(v: Vehicle): void {
    v.status = 'flight';
    v.rest = null;
    for (const e of v.engines) e.throttleCmd = 0;
    this.towers[v.caughtPad].floor = ARMS.minOffset;
    const br = this.mission.boosterReturn;
    if (br && v.id === 'booster') br.phase = 'lost';
    this.log(`${v.name} released: the chopsticks let go`);
    this.refreshAux();
  }

  /** A vehicle breaks up / crashes. */
  destroy(v: Vehicle, text: string): void {
    v.status = 'destroyed';
    for (const e of v.engines) e.throttleCmd = 0;
    this.log(text);
  }

  /** Split the stack into booster and ship at the hot-staging interface. */
  separate(): { booster: Vehicle; ship: Vehicle } {
    const stack = this.find('stack')!;
    const mp = massProps(stack.stages, stack.stages.map((s) => s.prop));
    const origin = sub(stack.r, qrot(stack.q, [mp.xcg, 0, 0]));
    const wEci = qrot(stack.q, stack.w);
    const make = (id: StageId, name: string) => {
      const idx = stack.stageIndex(id);
      const engines = stack.engines.filter((e) => e.stage === idx).map((e) => ({ ...e, stage: 0 }));
      const v = new Vehicle(id, name, [stack.stages[idx]], engines);
      const mpv = massProps(v.stages, v.stages.map((s) => s.prop));
      const offset = qrot(stack.q, [mpv.xcg, 0, 0]);
      v.q = [...stack.q];
      v.w = [...stack.w];
      v.r = add(origin, offset);
      v.v = add(stack.v, cross(wEci, sub(v.r, stack.r)));
      v.status = 'flight';
      v.caughtPad = stack.caughtPad;
      // Its flaps / fins where they were on the stack (they move to neutral from there).
      carryAngles(stack, v);
      return v;
    };
    const booster = make('booster', 'Super Heavy');
    const ship = make('ship', 'Starship');
    this.vehicles = this.vehicles.filter((v) => v !== stack).concat([booster, ship]);
    // Whoever flew the stack now flies the ship; the booster heads home on autopilot.
    if (this.pilot.cmd.target === 'stack') this.pilot.set({ target: 'ship' });
    this.refreshAux();
    return { booster, ship };
  }

  /** SAS's current aim in the flown vehicle's local ENU, if it's pointing somewhere. */
  private flownSasDirLocal(): V3 | null {
    const v = this.vehicles.find((x) => x.id === this.pilot.cmd.target);
    const aux = v && this.aux.get(v.id);
    if (!v || !aux || !this.pilot.sasDir) return null;
    const b = localBasisEci(aux.geo, this.t);
    return mat3Vec([...b.e, ...b.n, ...b.u], this.pilot.sasDir);
  }

  /**
   * Coast trajectories (engines off from now) of everything in flight, for the map view.
   * Drag areas are rough: the stack flies nose-first, the booster falls engines-first with its
   * grid fins out, the ship enters belly-first at 60 deg angle of attack (lift up, L/D ~0.53,
   * like its entry autopilot) and falls flat below ~Mach 3.
   */
  predictTrajectories(): Trajectory[] {
    const out: Trajectory[] = [];
    for (const v of this.vehicles) {
      if (v.status !== 'flight') continue;
      const aux = this.aux.get(v.id) ?? currentAux(v, this.t, this.env);
      const ids = v.stages.map((s) => s.def.id);
      const model: EntryModel =
        ids.length > 1 ? { dragArea: 30 } : ids[0] === 'booster' ? { dragArea: 80 } : SHIP_ENTRY;
      out.push(predictTrajectory(v.id, v.r, v.v, this.t, model, aux.mp.mass));
      const rem = this.maneuverRemaining();
      if (this.node && rem && this.node.node.vehicle === v.id) {
        const burn = { t: Math.max(this.t, this.node.node.t), dv: rem.vec };
        out.push({ ...predictTrajectory(v.id, v.r, v.v, this.t, model, aux.mp.mass, burn), id: `${v.id}:node` });
      }
    }
    return out;
  }

  /** Player staging (Space in flight). */
  stage(): void {
    this.mission.stage();
  }

  /** Events added since the last call. */
  drainEvents(): SimEvent[] {
    const out = this.events.slice(this.eventCursor);
    this.eventCursor = this.events.length;
    return out;
  }

  snapshot(): Snapshot {
    const toEcef = eciToEcefMatrix(this.t);
    const bodyToEnuBase = mat3Mul(ECEF_TO_ENU, toEcef);
    const vehicles = this.vehicles.map((v): VehicleSnapshot => {
      const aux = this.aux.get(v.id) ?? currentAux(v, this.t, this.env);
      const origin = sub(v.r, qrot(v.q, [aux.mp.xcg, 0, 0]));
      const d = sub(eciToEcef(origin, this.t), PAD_GROUND_ECEF);
      const up = ecefToEci(enuBasis(aux.geo.lat, aux.geo.lon).u, this.t);
      const aps = orbitApsides(v.r, v.v);
      const basis = localBasisEci(aux.geo, this.t);
      const toLocal: M3 = [...basis.e, ...basis.n, ...basis.u];
      const perf = flightPerformance(v, aux);
      const stageState: VehicleSnapshot['stageState'] = {};
      v.stages.forEach((s, i) => {
        const engines = v.engines.filter((e) => e.stage === i);
        const g = engines.reduce((m, e) => Math.max(m, Math.hypot(e.gy, e.gz)), 0);
        const steer = engines.find((e) => e.place.type.gimbalMax > 0);
        stageState[s.def.id] = {
          propFrac: s.prop / s.def.propMass,
          throttles: engines.map((e) => e.throttle),
          gimbalDeg: g / DEG,
          gimbal: steer ? [steer.gy, steer.gz] : [0, 0],
          gimbals: engines.map((e) => e.place.type.gimbalMax > 0),
        };
      });
      return {
        id: v.id,
        name: v.name,
        status: v.status,
        venting: v.ventUntil > this.t,
        stages: v.stages.map((s) => s.def.id),
        pos: mat3Vec(ECEF_TO_ENU, d),
        rot: mat3Mul(bodyToEnuBase, mat3FromQ(v.q)),
        xcg: aux.mp.xcg,
        telemetry: {
          // Like the webcast readout: 0 on the launch mount; away from Starbase, height of the
          // vehicle's base above the sea.
          altitude: Math.max(
            0,
            ecefToGeodetic(eciToEcef(add(origin, qrot(v.q, [v.extent[0], 0, 0])), this.t)).h -
              (downrange(v.r, this.t) < 4000 ? PAD.groundAlt + PAD.mountHeight : 0),
          ),
          speed: norm(aux.vAir),
          inertialSpeed: norm(v.v),
          verticalSpeed: dot(v.v, up),
          downrange: downrange(v.r, this.t),
          mach: aux.mach,
          q: aux.q,
          accelG: v.status === 'held' ? 1 : aux.properAccel / G0,
          pAmb: aux.pAmb,
          mass: aux.mp.mass,
          perigee: aps.perigee,
          apogee: aps.apogee,
          alphaDeg: aux.alpha / DEG,
          heatFlux: v.status === 'flight' ? heatFlux(aux.rho, aux.mach * aux.soundSpeed) : 0,
          lat: aux.geo.lat / DEG,
          lon: aux.geo.lon / DEG,
          vAirEnu: mat3Vec(ECEF_TO_ENU, eciToEcef(airRelativeVelocity(v.r, v.v), this.t)),
          rotLocal: mat3Mul(toLocal, mat3FromQ(v.q)),
          vSurfLocal: mat3Vec(toLocal, aux.vAir),
          vOrbLocal: mat3Vec(toLocal, v.v),
          normalLocal: mat3Vec(toLocal, normalize(cross(v.r, v.v))),
          ...perf,
        },
        health: this.health.get(v.id) ?? newHealth(),
        surfaces: v.surfaces.map((s, i) => ({ name: s.def.name, angle: v.surfaceAngles[i] })),
        stageState,
      };
    });
    return {
      t: this.t,
      missionTime: this.mission.missionTime,
      phase: this.mission.phase,
      vehicles,
      events: this.drainEvents(),
      towers: this.towers.map((a) => ({ offset: a.offset, angle: a.angle, top: a.top, broken: { ...a.broken }, down: a.down, fallDir: a.fallDir, slew: a.slew, qd: a.qd, qdBroken: a.qdBroken })),
      shipPhase: this.mission.shipReentry?.phase ?? null,
      pilot: { ...this.pilot.cmd, sasDirLocal: this.flownSasDirLocal() },
      catchGuide: this.catchGuide(),
      node: this.nodeSnapshot(),
      railsOk: this.railsAllowed(),
      shipReturn: this.returnSnapshot(),
      waitUntil: this.waitUntil,
      returnNotice: this.returnNotice,
    };
  }

  private returnSnapshot(): Snapshot['shipReturn'] {
    const r = this.mission.shipReturn;
    if (!r) return null;
    const ship = this.find('ship');
    const aux = ship && this.aux.get(ship.id);
    return {
      target: r.target,
      targetLatLon: targetLatLon(r.target),
      phase: r.phase,
      status: r.status,
      burns: r.plan.burns.map((b) => ({ label: b.label, t: b.t, dv: norm(b.dv) })),
      predicted: r.predicted,
      dvNeeded: r.plan.dvNeeded,
      dvAvailable: r.plan.dvAvailable,
      paused: !!ship && this.pilot.flies(ship),
      handBackBy: ship && aux ? r.handBackBy(ship, aux) : null,
      height: aux ? aux.geo.h - (r.target.kind === 'ocean' ? 0 : PAD.groundAlt) : null,
    };
  }

  nodeSnapshot(): Snapshot['node'] {
    const rem = this.maneuverRemaining();
    if (!this.node || !rem) return null;
    const v = this.find(this.node.node.vehicle);
    const aux = v && this.aux.get(v.id);
    if (!v || !aux) return null;
    const b = localBasisEci(aux.geo, this.t);
    const perf = flightPerformance(v, aux);
    const accel = (perf.twrMax * G0);
    return {
      ...this.node.node,
      remaining: rem.mag,
      remainingLocal: mat3Vec([...b.e, ...b.n, ...b.u], rem.dir),
      burnTime: accel > 0 ? rem.mag / accel : Infinity,
    };
  }

  /** Catch guidance while the player flies the booster home. */
  private catchGuide(): CatchGuide | null {
    const b = this.find('booster');
    const br = this.mission.boosterReturn;
    if (!b || !br || b.status !== 'flight' || !this.pilot.flies(b)) return null;
    return br.guide(b, this.aux.get('booster') ?? currentAux(b, this.t, this.env));
  }
}

/** Thrust-to-weight now / at full throttle, and delta-v left per stage (rocket equation). */
function flightPerformance(v: Vehicle, aux: Aux): { twr: number; twrMax: number; deltaV: Partial<Record<StageId, number>> } {
  const weight = aux.mp.mass * G0;
  const active = v.stageIndex('booster') >= 0 ? v.stageIndex('booster') : 0;
  let full = 0;
  for (const e of v.engines) if (e.stage === active && !e.failed && v.stages[e.stage].prop > 0) full += engineThrust(e.place.type, 1, aux.pAmb);
  const deltaV: Partial<Record<StageId, number>> = {};
  let upper = 0; // dry + propellant of the stages above (they ride along)
  for (let i = v.stages.length - 1; i >= 0; i--) {
    const s = v.stages[i];
    const engines = v.engines.filter((e) => e.stage === i && !e.failed);
    let thrust = 0;
    let flow = 0;
    for (const e of engines) {
      thrust += engineThrust(e.place.type, 1, aux.pAmb);
      flow += engineMassFlow(e.place.type, 1);
    }
    const m0 = upper + s.def.dryMass + s.prop;
    const isp = flow > 0 ? thrust / (flow * G0) : 0;
    deltaV[s.def.id] = isp > 0 ? isp * G0 * Math.log(m0 / (m0 - s.prop)) : 0;
    upper = m0;
  }
  return { twr: aux.thrust / weight, twrMax: full / weight, deltaV };
}

/** Rotation about the Earth's axis (ECI z) by angle th, as a quaternion. */
const qSpin = (th: number): Q => [Math.cos(th / 2), 0, 0, Math.sin(th / 2)];

/** Hold a landed vehicle where it came to rest, turning with the Earth. */
function restOnEarth(v: Vehicle, t: number, dt: number): void {
  if (!v.rest) v.rest = { rEcef: eciToEcef(v.r, t), qEcef: qmul(qSpin(-OMEGA_E * t), v.q) };
  const t1 = t + dt;
  v.r = ecefToEci(v.rest.rEcef, t1);
  v.q = qmul(qSpin(OMEGA_E * t1), v.rest.qEcef);
  v.v = cross([0, 0, OMEGA_E], v.r);
  v.w = qrotInv(v.q, [0, 0, OMEGA_E]);
}

/** Great-circle distance from the pad along the surface, m. */
function downrange(rEci: V3, t: number): number {
  const p = eciToEcef(rEci, t);
  const c = dot(p, PAD_GROUND_ECEF) / (norm(p) * norm(PAD_GROUND_ECEF));
  return Math.acos(clamp(c, -1, 1)) * 6371000;
}

/**
 * Clamp the vehicle over the launch mount, nose up, co-rotating with the Earth: base at the mount
 * top, or at `baseHeight` above the ground (a booster hanging on the chopsticks).
 */
export function placeOnPad(v: Vehicle, t: number, baseHeight = PAD.mountHeight, pad = 0, slewDeg = 0): void {
  const status = v.status;
  const mp = massProps(v.stages, v.stages.map((s) => s.prop));
  const { e, n, u } = enuBasis(padLat, padLon);
  const [me, mn] = catchPoint(pad, slewDeg);
  const upEci = ecefToEci(u, t);
  // The vehicle's own base (not the body origin, which is the booster's base) at that height.
  v.r = add(padToEci([me, mn, baseHeight], t), scale(upEci, mp.xcg - v.extent[0]));
  v.v = cross([0, 0, OMEGA_E], v.r);
  // Body x = up, y (the ship's belly) away from the tower, z across the arms' gap (the catch
  // pins / fittings on +-z rest on the rails). Pad 1: y = east, z = north. Hanging on the arms
  // it keeps whichever way round it was caught.
  // (Swung round the tower by the arms: turned with them.)
  const turn = (d: V3): V3 => {
    const a = (slewDeg * Math.PI) / 180;
    return [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a), 0];
  };
  const enu = (d: V3) => ecefToEci(add(scale(e, d[0]), scale(n, d[1])), t);
  let y = enu(turn(awayFromTower(pad)));
  let z = enu(turn(catchGap(pad)));
  if (status === 'caught' && dot(qrot(v.q, [0, 0, 1]), z) < 0) {
    y = scale(y, -1);
    z = scale(z, -1);
  }
  v.q = qFromMat3(mat3FromColumns(upEci, y, z));
  v.w = qrotInv(v.q, [0, 0, OMEGA_E]);
  v.status = status === 'caught' ? 'caught' : 'held';
}

/** A vehicle tipping over the edge of its base (pad ENU). */
interface Topple {
  pivot: V3;
  /** Horizontal direction it's tipping toward. */
  dir: V3;
  /** Tip angle from its standing pose (rad) and its rate (rad/s). */
  angle: number;
  rate: number;
  /** Standing pose: CG relative to the pivot, and the body axes. */
  cgRel: V3;
  axes: [V3, V3, V3];
  length: number;
  /** CG height above the base, m, and the hull radius. */
  hcg: number;
  radius: number;
}

/** Fastest an arm (swinging, lifting or closing) can shove a vehicle, m/s. */
const ARM_PUSH_SPEED = 2;

/** An arm has to press this far into a standing vehicle (m) to start tipping it. */
const TOPPLE_PUSH_DEPTH = 0.15;

/** Rotate a pad-ENU vector by `angle` about the horizontal axis that tips "up" toward `dir`. */
function rotateAbout(p: V3, dir: V3, angle: number): V3 {
  const k = cross([0, 0, 1], dir);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Rodrigues' rotation formula.
  return add(add(scale(p, c), scale(cross(k, p), s)), scale(k, dot(k, p) * (1 - c)));
}

/**
 * Height of a vehicle's lifting points above its base, m: the booster's catch fittings, the
 * ship's (Block 3 ships are lifted by them too); a stack is lifted apart by its ship's.
 */
function liftPoint(v: Vehicle): number | null {
  if (v.id === 'booster') return CATCH.finBottom;
  if (v.id === 'ship') return SHIP_CATCH_PIN;
  if (v.id === 'stack') return STARSHIP_V3.xBase + SHIP_CATCH_PIN;
  return null;
}

/** Copy the control surfaces' angles from one vehicle to another carrying the same surfaces. */
function carryAngles(from: Vehicle, to: Vehicle): void {
  to.surfaces.forEach((s, i) => {
    const k = from.surfaces.findIndex((o) => o.def === s.def);
    if (k >= 0) to.surfaceAngles[i] = from.surfaceAngles[k];
  });
}

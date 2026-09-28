// Flight software timeline: countdown, ignition, liftoff, max-Q, MECO, hot staging,
// separation, ship insertion burn and SECO. Also runs guidance + control each cycle.

import { DEG, G0, PAD } from './constants';
import { MISSION } from './config/starshipV3';
import { BoosterReturn } from './boosterReturn';
import { SHIP_ENTRY, ShipReentry } from './shipReentry';
import { ShipReturn } from './shipReturn';
import { predictTrajectory } from './trajectory';
import { ARMS } from './tower';
import { applyControl } from './control';
import { engineThrust } from './engine';
import { GravityTurnGuidance, InsertionGuidance, orbitApsides } from './guidance';
import { type V3, add, clamp, dot, norm, normalize, qrot, scale, sub } from './math';
import type { Aux } from './dynamics';
import type { Simulation } from './simulation';
import { type Vehicle, setThrottle } from './vehicle';

export type Phase = 'prelaunch' | 'countdown' | 'ascent' | 'hotstaging' | 'shipburn' | 'coast' | 'aborted';

const fmt = (x: number, digits = 0) => x.toFixed(digits);

export class Mission {
  phase: Phase = 'prelaunch';
  tZero: number | null = null;
  liftoffT: number | null = null;
  private ignited = [false, false, false];
  private maxQ = { q: 0, t: 0 };
  private tMeco = 0;
  private flags = new Set<string>();
  private booster = new GravityTurnGuidance(MISSION.azimuthDeg, MISSION.kickStart, MISSION.kickAngleDeg);
  private ship = new InsertionGuidance(MISSION.shipTargetAlt, MISSION.shipClimbAtCutoff);
  private lastTarget: V3 | null = null;
  /** Booster return-to-launch-site and catch, from stage separation on. */
  boosterReturn: BoosterReturn | null = null;
  /** Ship entry, belly-flop, flip and landing burn, from SECO on. */
  shipReentry: ShipReentry | null = null;
  /** The ship's commanded return (tower / ocean target); flies instead of shipReentry. */
  shipReturn: ShipReturn | null = null;
  /** Next time to predict the ship's splashdown during its insertion burn (sim time). */
  private nextSplashCheck = 0;
  /** Close to the splashdown target: minimum throttle for a precise cutoff. */
  private splashTrim = false;
  /** The player has been flying the ship (a return autopilot waits for it to be handed back). */
  private shipManual = false;

  constructor(private sim: Simulation) {}

  get missionTime(): number | null {
    return this.tZero === null ? null : this.sim.t - this.tZero;
  }

  launch(): void {
    if (this.phase !== 'prelaunch') return;
    if (this.sim.find('stack')?.status !== 'held') {
      this.sim.log("Can't launch: Starship isn't stacked on Super Heavy on the launch mount");
      return;
    }
    // From whichever pad it's stacked on (it may have been restacked on the other one).
    this.sim.launchPad = this.sim.find('stack')!.caughtPad;
    this.tZero = this.sim.t + MISSION.countdown;
    this.phase = 'countdown';
    this.sim.log('Countdown started');
    // The arms go back to facing the mount if they were swung aside (the launch opens them wide).
    this.sim.towers[this.sim.launchPad].command({ slew: 0 });
  }

  /** Run a one-shot action the first time `cond` holds. */
  private once(key: string, cond: boolean, fn: () => void): void {
    if (cond && !this.flags.has(key)) {
      this.flags.add(key);
      fn();
    }
  }

  update(dt: number): void {
    const tm = this.missionTime;
    const sim = this.sim;
    const stack = sim.find('stack');
    const booster = sim.find('booster');
    const ship = sim.find('ship');
    for (const v of sim.vehicles) v.extForce = [0, 0, 0];

    switch (this.phase) {
      case 'countdown': {
        if (!stack || tm === null) break;
        // Terminal count: the ship QD arm swings back to the tower.
        this.once('qdStow', tm >= -9, () => {
          sim.towers[sim.launchPad].stowQd(true);
          sim.log('Ship QD arm retracting');
        });
        // Terminal count: the chopsticks swing wide open, well clear of the vehicle for liftoff.
        this.once('armsWide', tm >= -7, () => {
          sim.towers[sim.launchPad].command({ angle: ARMS.maxOpenDeg, slew: 0 });
          sim.log('Chopsticks opening wide for launch');
        });
        // Staggered start: center, inner ring, outer ring.
        [0, 1, 2].forEach((ring) => {
          if (!this.ignited[ring] && tm >= MISSION.ignitionAt + ring * 0.3) {
            this.ignited[ring] = true;
            setThrottle(stack, 'booster', 1, (r) => r === ring);
            if (ring === 0) sim.log('Raptor ignition sequence start');
          }
        });
        if (tm >= 0) {
          const aux = sim.aux.get('stack')!;
          const twr = aux.thrust / (aux.mp.mass * G0);
          if (twr >= MISSION.releaseTwr) {
            stack.status = 'flight';
            this.liftoffT = sim.t;
            this.phase = 'ascent';
            sim.log(`Liftoff (T/W ${fmt(twr, 2)})`);
          } else if (tm > 3) {
            setThrottle(stack, 'booster', 0);
            this.phase = 'aborted';
            sim.log(`Abort: insufficient thrust (T/W ${fmt(twr, 2)})`);
          }
        }
        break;
      }

      case 'ascent': {
        if (!stack) break;
        const aux = sim.aux.get('stack')!;
        const since = sim.t - this.liftoffT!;
        this.once('tower', since > 1 && aux.geo.h > 160, () => sim.log('Tower cleared'));
        // Max-Q detection and throttle bucket.
        if (aux.q > this.maxQ.q) this.maxQ = { q: aux.q, t: tm! };
        this.once('maxq', this.maxQ.q > 5e3 && aux.q < this.maxQ.q * 0.97, () =>
          sim.log(`Max-Q ${fmt(this.maxQ.q / 1000, 1)} kPa at T+${fmt(this.maxQ.t)} s`),
        );
        this.once('mach1', aux.mach >= 1, () => sim.log('Supersonic'));
        const bi = stack.stageIndex('booster');
        const atReserve = stack.stages[bi].prop <= SUPER_HEAVY_RESERVE(stack);
        if (this.auto(stack)) {
          const bucket = aux.q > MISSION.qBucket;
          setThrottle(stack, 'booster', bucket ? MISSION.qBucketThrottle : 1);
          const target = this.booster.target(stack, aux, sim.t, since);
          this.lastTarget = target;
          applyControl(stack, aux, target, dt);
          if (atReserve) this.startStaging(aux, 'Booster MECO');
        } else {
          this.lastTarget = qrot(stack.q, [1, 0, 0]);
          this.once('reserveWarn', atReserve, () => sim.log('Booster at its return reserve: stage now (Space) to bring it home'));
        }
        break;
      }

      case 'hotstaging': {
        const dtm = sim.t - this.tMeco;
        this.once('shipIgn', dtm >= MISSION.shipIgnitionDelay && !!stack, () => {
          setThrottle(stack!, 'ship', 1, (r) => r === 0);
          sim.log('Ship engine ignition (hot staging)');
        });
        if (stack) {
          const aux = sim.aux.get('stack')!;
          if (this.auto(stack)) applyControl(stack, aux, this.lastTarget ?? normalize(aux.vAir), dt);
          else sim.pilot.apply(stack, aux, dt, false);
          if (dtm >= MISSION.separationDelay) {
            sim.separate();
            sim.log('Stage separation');
            this.boosterReturn = new BoosterReturn(sim, (text) => sim.log(text), sim.towers[sim.launchPad], sim.launchPad, sim.boosterOcean);
          }
          break;
        }
        if (booster && ship) {
          this.plumeImpingement(ship, booster);
          this.once('rvac', dtm >= MISSION.rvacIgnitionDelay, () => {
            setThrottle(ship, 'ship', 1);
            this.phase = 'shipburn';
            sim.log('RVac ignition');
            // The player (if flying) takes the throttle from here, at full.
            if (sim.pilot.cmd.manual) sim.pilot.set({ throttle: 1, engines: 0 });
          });
          const sAux = sim.aux.get('ship')!;
          if (this.auto(ship)) applyControl(ship, sAux, normalize(ship.v), dt);
          else sim.pilot.apply(ship, sAux, dt, false);
        }
        break;
      }

      case 'shipburn': {
        if (!ship) break;
        const aux = sim.aux.get('ship')!;
        if (booster && booster.status !== 'destroyed') this.plumeImpingement(ship, booster);
        if (!this.auto(ship)) {
          // Player's burn: it ends when they shut the engines down.
          if (ship.engines.every((e) => e.throttleCmd <= 0 && e.throttle <= 0.02)) {
            const aps = orbitApsides(ship.r, ship.v);
            this.phase = 'coast';
            this.shipReentry = new ShipReentry(sim, (text) => sim.log(text));
            sim.log(`SECO (manual): ${fmt(norm(aux.vAir) * 3.6)} km/h, alt ${fmt(aux.geo.h / 1000)} km, orbit ${fmt(aps.perigee / 1000)} x ${fmt(aps.apogee / 1000)} km`);
          }
          break;
        }
        // Throttle to the acceleration limit (down to the minimum for a precise cutoff at the end).
        const full = ship.engines.reduce((a, e) => a + engineThrust(e.place.type, 1, aux.pAmb), 0);
        setThrottle(ship, 'ship', this.splashTrim ? 0.4 : clamp((MISSION.shipMaxAccelG * G0 * aux.mp.mass) / full, 0.4, 1));
        applyControl(ship, aux, this.ship.target(ship, aux, sim.t), dt);
        const aps = orbitApsides(ship.r, ship.v);
        const low = ship.stages[0].prop <= ship.stages[0].def.reserve;
        // Aim the splashdown: cut off once the predicted impact reaches the target zone.
        let onTarget = false;
        if (aps.perigee > MISSION.splashCheckPerigee && sim.t >= this.nextSplashCheck) {
          const p = predictTrajectory('seco', ship.r, ship.v, sim.t, SHIP_ENTRY, aux.mp.mass);
          if (p.impact) {
            const short = (downrangeAngle(MISSION.splashTarget) - downrangeAngle(p.impact)) * 6371;
            onTarget = short <= 0;
            this.splashTrim = short < 1500;
            this.nextSplashCheck = sim.t + (short < 300 ? 0 : short < 1500 ? 0.05 : 0.2);
          } else this.nextSplashCheck = sim.t + 0.2;
        }
        if (onTarget || aps.perigee >= MISSION.targetPerigeeAlt || low) {
          setThrottle(ship, 'ship', 0);
          this.phase = 'coast';
          this.shipReentry = new ShipReentry(sim, (text) => sim.log(text));
          sim.log(
            `${low ? 'SECO (propellant reserve reached)' : 'SECO'}: ${fmt(norm(aux.vAir) * 3.6)} km/h, ` +
              `alt ${fmt(aux.geo.h / 1000)} km, orbit ${fmt(aps.perigee / 1000)} x ${fmt(aps.apogee / 1000)} km`,
          );
          // The entry guidance steers onto the splashdown target (range and crossrange) if it's in
          // reach without a burn; otherwise the plain entry profile.
          const aim = new ShipReturn(sim, ship, { kind: 'ocean', ...MISSION.splashTarget }, (text) => sim.log(text));
          if (aim.phase !== 'lost' && aim.plan.burns.length === 0) this.shipReturn = aim;
        }
        break;
      }

      case 'coast':
        if (ship && ship.status === 'flight' && this.auto(ship)) {
          // Handed back after the player flew it: the return picks up from where the ship is now.
          if (this.shipReturn && this.shipManual) this.shipReturn.resume(ship, sim.aux.get('ship')!);
          this.shipManual = false;
          if (this.shipReturn) this.shipReturn.update(ship, sim.aux.get('ship')!, dt);
          else this.shipReentry?.update(ship, sim.aux.get('ship')!, dt);
        } else if (ship) this.shipManual = true;
        break;

      default:
        break;
    }

    if (booster && this.boosterReturn && booster.status === 'flight') {
      if (this.auto(booster)) this.boosterReturn.update(booster, sim.aux.get('booster')!, dt);
      else this.boosterReturn.watchCatch(booster, sim.aux.get('booster')!);
    }

    // The player flies their vehicle (hot staging applies its own control above).
    const flown = sim.vehicles.find((v) => sim.pilot.flies(v));
    if (flown && this.phase !== 'hotstaging') sim.pilot.apply(flown, sim.aux.get(flown.id)!, dt);

    // Anything flying without an active control law just damps its rates.
    for (const v of sim.vehicles) {
      if (v.status !== 'flight' || sim.pilot.flies(v)) continue;
      const controlled =
        (v.id === 'stack' && (this.phase === 'ascent' || this.phase === 'hotstaging')) ||
        (v.id === 'ship' && this.phase !== 'prelaunch') ||
        (v.id === 'booster' && this.boosterReturn !== null);
      if (!controlled) applyControl(v, sim.aux.get(v.id)!, null, dt);
    }
  }

  /** Whether the autopilot flies this vehicle (the player isn't). */
  private auto(v: Vehicle): boolean {
    return !this.sim.pilot.flies(v);
  }

  /** Booster MECO and the hot-staging sequence (ship ignition, separation, RVac ignition). */
  private startStaging(aux: Aux, label: string): void {
    const stack = this.sim.find('stack')!;
    setThrottle(stack, 'booster', 0, (r) => r > 0);
    setThrottle(stack, 'booster', 0.4, (r) => r === 0);
    this.tMeco = this.sim.t;
    this.phase = 'hotstaging';
    this.sim.log(`${label}: ${fmt(aux.geo.h / 1000, 1)} km, ${fmt(norm(aux.vAir) * 3.6)} km/h`);
  }

  /** Player staging (Space in flight): hot-stage the stack now. */
  stage(): void {
    const stack = this.sim.find('stack');
    if (this.phase !== 'ascent' || !stack || stack.status !== 'flight') return;
    this.startStaging(this.sim.aux.get('stack')!, 'Staging: booster MECO');
  }

  /** Early in separation the ship's exhaust pushes the booster away. */
  private plumeImpingement(ship: Vehicle, booster: Vehicle): void {
    const d = norm(sub(ship.r, booster.r));
    const sAux = this.sim.aux.get('ship');
    if (!sAux || sAux.thrust <= 0) return;
    const range = 120; // CG-to-CG distance where impingement fades out, m
    if (d > range) return;
    const axis = qrot(ship.q, [1, 0, 0]);
    booster.extForce = scale(axis, -0.35 * sAux.thrust * (1 - d / range));
    // Sanity: the push should oppose the ship's travel direction.
    if (dot(booster.extForce, ship.v) > 0) booster.extForce = [0, 0, 0];
  }
}

const SUPER_HEAVY_RESERVE = (v: Vehicle) => v.stages[v.stageIndex('booster')].def.reserve;

/**
 * How far round the Earth a point is from the pad along the launch direction, rad (0..2 pi): its
 * angle in the plane of the great circle leaving the pad on the launch azimuth. Grows steadily
 * along the ground track, even past halfway round (a great-circle distance doesn't).
 */
function downrangeAngle(p: { lat: number; lon: number }): number {
  const unit = (latDeg: number, lonDeg: number): V3 => {
    const la = latDeg * DEG;
    const lo = lonDeg * DEG;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const u0 = unit(PAD.latDeg, PAD.lonDeg);
  const la = PAD.latDeg * DEG;
  const lo = PAD.lonDeg * DEG;
  const east: V3 = [-Math.sin(lo), Math.cos(lo), 0];
  const north: V3 = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const az = MISSION.azimuthDeg * DEG;
  const a0 = add(scale(east, Math.sin(az)), scale(north, Math.cos(az)));
  const q = unit(p.lat, p.lon);
  const ang = Math.atan2(dot(q, a0), dot(q, u0));
  return ang < 0 ? ang + 2 * Math.PI : ang;
}

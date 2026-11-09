// Starlink deployment from Starship's payload bay, as on Flight 14 and Flight 15: once the ship is
// in orbit it turns to the deployment attitude (door facing down), the PEZ door opens,
// the dispenser pushes the satellites out one at a time through the slot (one every ~70 s), and
// the door closes behind the last. Each one
// leaves the ship lighter (its mass comes off the ship's payload) and flies on its own orbit from
// there: drifting slowly away, turning lazily, and soon spreading its solar wings.

import { STARLINK_V3, STARSHIP_V3 } from './config/starshipV3';
import { RE } from './constants';
import { type Q, type V3, add, cross, dot, norm, qmul, qrot, scale } from './math';
import { orbitApsides } from './guidance';
import { propagate } from './trajectory';
import { type Vehicle, massProps, payloadOf } from './vehicle';

export type BayState = 'stowed' | 'orienting' | 'opening' | 'deploying' | 'closing' | 'done';

/** A deployed satellite, flying on its own (two-body: no drag over the hours it's in view). */
export interface Satellite {
  /** 1-based, in the order they left. */
  n: number;
  r: V3;
  v: V3;
  /** Sim time its state is at, and when it left the ship. */
  t: number;
  released: number;
  /** Attitude at release (the satellite's axes: the ship's body axes then), and its slow tip-off tumble, rad/s (body). */
  q0: Q;
  spin: V3;
}

/** How long a satellite is kept after release (far out of sight by then), s. */
const KEEP = 3 * 3600;
/** A satellite this low has re-entered (a suborbital release), m. */
const BURN_UP_ALT = 100e3;
/**
 * Each satellite's own attitude control takes over this long after release and stops its
 * tumble (time constant DETUMBLE_TAU): it holds still from there, wings stowed until they open.
 */
const DETUMBLE_AT = 90;
const DETUMBLE_TAU = 45;
/** Its tip-off tumble starts once it's clear of the slot (it slides out on the dispenser's rails until then), s after release. */
const CLEAR_SLOT = (STARLINK_V3.width + 0.6) / STARLINK_V3.pushSpeed;
/** The ship is at the deployment attitude when within this (rad) and turning slower than this (rad/s). */
const ALIGNED = 3 * (Math.PI / 180);
const SETTLED = 0.003;

/**
 * The ship's attitude for a deployment, set as it starts and held fixed in space from there (as
 * the ship holds still between burns): the door (body -y) facing behind and a little down, the
 * nose up and back. Over the half hour of the deployment the orbit carries the ship a third of
 * the way round, so the door sweeps through straight down to down-and-ahead: each satellite
 * leaves on its own path relative to the ship (the first ones drifting ahead, the last behind),
 * not all on one looping path that would bring them back through each other. (Chosen with the
 * Clohessy-Wiltshire relative motion: this keeps every pair tens of metres apart for hours.)
 */
export function deployAttitude(ship: Vehicle): { nose: V3; bodyZ: V3; door: V3 } {
  const R = norm3(ship.r);
  const N = norm3(cross(ship.r, ship.v));
  const T = cross(N, R);
  const door = add(scale(R, -0.5), scale(T, -0.866));
  const nose = add(scale(R, 0.866), scale(T, -0.5));
  // Body axes: x the nose, y away from the door, z = x cross y.
  const bodyZ = cross(nose, scale(door, -1));
  return { nose, bodyZ, door };
}

const norm3 = (a: V3): V3 => scale(a, 1 / Math.max(1e-9, norm(a)));

export class PayloadBay {
  state: BayState = 'stowed';
  /** Door opening, 0 (closed) .. 1 (open). */
  door = 0;
  aboard: number;
  readonly total: number;
  sats: Satellite[] = [];
  /**
   * Deploys on its own at the planned time (the missions); off, it waits for the player to ask
   * (request()). A deployment the player holds also turns this off.
   */
  auto: boolean;
  private nextRelease = Infinity;
  private lastRelease = -Infinity;
  /** Holding: the door closes with satellites still aboard (back to stowed). */
  private holding = false;
  /** The deployment attitude (ECI), fixed as the deployment starts. */
  private attitude: { nose: V3; bodyZ: V3; door: V3 } | null = null;
  private seed = 7;

  constructor(count = STARLINK_V3.count, auto = true) {
    this.aboard = count;
    this.total = count;
    this.auto = auto;
  }

  /** The payload mass for this many aboard, kg. */
  static massFor(count: number): number {
    return count * STARLINK_V3.mass;
  }

  /** Seconds until the dispenser pushes the next one out (deploying), else null. */
  nextIn(t: number): number | null {
    return this.state === 'deploying' && Number.isFinite(this.nextRelease) ? Math.max(0, this.nextRelease - t) : null;
  }

  /** Seconds since the last one left (the stack moves up to the slot after it). */
  sinceRelease(t: number): number {
    return t - this.lastRelease;
  }

  /** Whether the bay is busy (time must run at physics speed, not on rails). */
  get busy(): boolean {
    return this.state === 'orienting' || this.state === 'opening' || this.state === 'deploying' || this.state === 'closing';
  }

  /** Whether the ship should hold the deployment attitude now (from the turn to it until the last one is clear). */
  get wantsAttitude(): boolean {
    return this.busy && !(this.state === 'closing' && this.holding) && this.attitude !== null;
  }

  /** The attitude to hold (ECI, unit vectors: nose, body +z), while wantsAttitude. */
  get hold(): { nose: V3; bodyZ: V3 } | null {
    return this.wantsAttitude ? this.attitude : null;
  }

  /** Start the turn to the deployment attitude (fixed from the ship's place in its orbit now). */
  private orient(ship: Vehicle): void {
    const a = deployAttitude(ship);
    this.attitude = { nose: norm3(a.nose), bodyZ: norm3(a.bodyZ), door: norm3(a.door) };
    this.state = 'orienting';
  }

  /**
   * The player asks (B): start a deployment, hold one under way (the door closes, the rest stay
   * aboard), or open up again. Returns what to log.
   */
  request(ship: Vehicle | undefined, altitude: number): string {
    if (!ship || ship.status !== 'flight') return 'Starlinks deploy from the ship, once it has separated';
    if (this.aboard === 0) return `All ${this.total} Starlinks are already out`;
    switch (this.state) {
      case 'deploying':
      case 'opening':
      case 'orienting':
        this.auto = false;
        this.holding = true;
        this.state = 'closing';
        return `Starlink deployment held: ${this.aboard} still aboard, door closing`;
      case 'closing':
        if (!this.holding) return 'The door is closing';
        this.holding = false;
        this.state = this.attitude ? 'opening' : 'stowed';
        return `Starlink deployment resumed: ${this.aboard} to go`;
      default: {
        if (altitude < 120e3) return `Too low to deploy Starlinks (${Math.round(altitude / 1000)} km): wait until above 120 km`;
        if (firing(ship)) return 'Not while the engines are firing: deploy in a coast';
        this.orient(ship);
        return `Starlink deployment: ship turning to the deployment attitude, ${this.aboard} to go`;
      }
    }
  }

  /**
   * Each step. missionTime: since T-0 (null before the launch); ship: the ship, once separated;
   * log: the flight log.
   */
  update(t: number, dt: number, missionTime: number | null, ship: Vehicle | undefined, log: (text: string) => void): void {
    this.fly(t, log);
    if (!ship || ship.status !== 'flight' || missionTime === null) return;
    const on = firing(ship);
    // (Coming down toward the air on a suborbital path: the door closes on the rest.)
    if (this.busy && !this.holding && norm(ship.r) - RE < 110e3) {
      this.auto = false;
      this.holding = true;
      this.state = 'closing';
      log(`Starlink deployment stopped, too low: ${this.aboard} still aboard, door closing`);
    }
    switch (this.state) {
      case 'stowed': {
        // In a stable orbit, engines off, at the planned time.
        if (!this.auto || missionTime < STARLINK_V3.deployAt || on) break;
        if (orbitApsides(ship.r, ship.v).perigee < 120e3) break;
        this.orient(ship);
        break;
      }
      case 'orienting': {
        // Turned to the deployment attitude and steady there: the door opens.
        const want = this.attitude!;
        const nose = qrot(ship.q, [1, 0, 0]);
        const door = qrot(ship.q, [0, -1, 0]);
        const err = Math.max(Math.acos(Math.min(1, dot(nose, want.nose))), Math.acos(Math.min(1, dot(door, want.door))));
        if (err > ALIGNED || norm(ship.w) > SETTLED || on) break;
        this.state = 'opening';
        log(`Payload door opening: ${this.aboard === this.total ? this.total : this.aboard} Starlink V3 satellites to deploy`);
        break;
      }
      case 'opening':
        this.door = Math.min(1, this.door + dt / STARLINK_V3.doorTime);
        if (this.door >= 1) {
          this.state = 'deploying';
          this.nextRelease = t + 4;
        }
        break;
      case 'deploying':
        // (Not during a burn: it waits.)
        if (t >= this.nextRelease && !on) {
          this.release(ship, t);
          log(`Starlink ${this.total - this.aboard} of ${this.total} deployed`);
          // (The dispenser's cycle varies a little, one to the next.)
          this.nextRelease = t + STARLINK_V3.interval + 10 * this.rnd();
          if (this.aboard === 0) {
            this.state = 'closing';
            log(`All ${this.total} Starlink V3 satellites deployed`);
          }
        }
        break;
      case 'closing':
        if (t < this.lastRelease + 20) break; // (the last one clear of the slot first)
        this.door = Math.max(0, this.door - dt / STARLINK_V3.doorTime);
        if (this.door <= 0) {
          if (this.holding && this.aboard > 0) {
            this.holding = false;
            this.state = 'stowed';
            log(`Payload door shut: ${this.aboard} Starlinks still aboard`);
          } else {
            this.state = 'done';
            log('Payload door closed');
          }
        }
        break;
      default:
        break;
    }
  }

  /** -0.5 .. 0.5, repeatable. */
  private rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647 - 0.5;
  }

  /** The dispenser pushes the next one out through the door. */
  private release(ship: Vehicle, t: number): void {
    const st = ship.stages[0];
    const xcg = shipCg(ship);
    // The door: on the ship's leeward side (body -y), its middle STARLINK_V3.doorX above the base.
    // (Straight out of the slot, which it fills with only centimetres to spare, each push a
    // percent or two different: the dispenser's spring.)
    const speed = STARLINK_V3.pushSpeed * (1 + 0.04 * this.rnd());
    const out: V3 = qrot(ship.q, [0, -1, 0]);
    // (Its middle starts just inside the hull, its outer edge in the slot: it slides out of it
    // over the next ten seconds or so.)
    const rDoor: V3 = qrot(ship.q, [STARSHIP_V3.xBase + STARLINK_V3.doorX - xcg, -(STARSHIP_V3.radius - STARLINK_V3.width / 2 + 0.2), 0]);
    const wEci = qrot(ship.q, ship.w);
    const vSat = add(add(ship.v, cross(wEci, rDoor)), scale(out, speed));
    this.aboard--;
    this.lastRelease = t;
    const m = STARLINK_V3.mass;
    const mShip = shipMass(ship);
    st.payload = Math.max(0, payloadOf(st) - m);
    // (The push back on the ship.)
    ship.v = add(ship.v, scale(out, (-m * speed) / Math.max(mShip - m, 1)));
    this.sats.push({
      n: this.total - this.aboard,
      r: add(ship.r, rDoor),
      v: vSat,
      t,
      released: t,
      q0: [...ship.q],
      // (A slow tip-off tumble from coming off the rails: under a degree a second, until the
      // satellite's own attitude control stops it.)
      spin: [this.rnd() * 0.012, this.rnd() * 0.008, this.rnd() * 0.016],
    });
  }

  /** Every satellite on to time t (dropped once long gone, or once it has re-entered). */
  fly(t: number, log?: (text: string) => void): void {
    let fell = false;
    for (const s of this.sats) {
      if (s.t >= t) continue;
      const next = propagate(s.r, s.v, s.t, t, { dragArea: 0 }, STARLINK_V3.mass, 10);
      s.r = next.r;
      s.v = next.v;
      s.t = t;
      if (norm(s.r) - RE < BURN_UP_ALT) {
        fell = true;
        log?.(`Starlink ${s.n} re-entered and burned up`);
      }
    }
    if (fell) this.sats = this.sats.filter((s) => norm(s.r) - RE >= BURN_UP_ALT);
    if (this.sats.length && t - this.sats[0].released > KEEP) this.sats = this.sats.filter((s) => t - s.released <= KEEP);
  }

  /**
   * A satellite's attitude (its axes -> ECI) at time t: its tip-off tumble, slowing to a stop
   * once its attitude control takes over.
   */
  static attitude(s: Satellite, t: number): Q {
    const a = t - s.released - CLEAR_SLOT;
    if (a <= 0) return s.q0;
    const w = norm(s.spin);
    if (w < 1e-9) return s.q0;
    // (The angle turned so far: the full rate, then decaying.)
    const turned = a <= DETUMBLE_AT ? a : DETUMBLE_AT + DETUMBLE_TAU * (1 - Math.exp(-(a - DETUMBLE_AT) / DETUMBLE_TAU));
    const h = (w * turned) / 2;
    const k = Math.sin(h) / w;
    return qmul(s.q0, [Math.cos(h), s.spin[0] * k, s.spin[1] * k, s.spin[2] * k]);
  }
}

/** Whether the ship's engines are firing (or about to). */
function firing(ship: Vehicle): boolean {
  return ship.engines.some((e) => e.throttle > 0.02 || e.throttleCmd > 0);
}

/** The ship's mass and centre of mass height (from its stage state). */
function shipCg(ship: Vehicle): number {
  return massProps(ship.stages, ship.stages.map((s) => s.prop)).xcg;
}
function shipMass(ship: Vehicle): number {
  return massProps(ship.stages, ship.stages.map((s) => s.prop)).mass;
}

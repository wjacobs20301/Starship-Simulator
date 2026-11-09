// Starlink deployment from Starship's payload bay, as on Flight 14 and Flight 15: once the ship is
// in orbit, the PEZ door on its leeward side opens, the dispenser pushes the satellites out one
// at a time through the slot (one every ~70 s), and the door closes behind the last. Each one
// leaves the ship lighter (its mass comes off the ship's payload) and flies on its own orbit from
// there: drifting slowly away, turning lazily, and soon spreading its solar wings.

import { STARLINK_V3, STARSHIP_V3 } from './config/starshipV3';
import { type Q, type V3, add, cross, norm, qmul, qrot, scale } from './math';
import { orbitApsides } from './guidance';
import { propagate } from './trajectory';
import { type Vehicle, massProps, payloadOf } from './vehicle';

export type BayState = 'stowed' | 'opening' | 'deploying' | 'closing' | 'done';

/** A deployed satellite, flying on its own (two-body: no drag over the hours it's in view). */
export interface Satellite {
  /** 1-based, in the order they left. */
  n: number;
  r: V3;
  v: V3;
  /** Sim time its state is at, and when it left the ship. */
  t: number;
  released: number;
  /** Attitude at release (the satellite's axes: the ship's body axes then), and its slow tumble, rad/s (body). */
  q0: Q;
  spin: V3;
}

/** How long a satellite is kept after release (far out of sight by then), s. */
const KEEP = 3 * 3600;

export class PayloadBay {
  state: BayState = 'stowed';
  /** Door opening, 0 (closed) .. 1 (open). */
  door = 0;
  aboard: number;
  readonly total: number;
  sats: Satellite[] = [];
  private nextRelease = Infinity;
  private lastRelease = -Infinity;
  private seed = 7;

  constructor(count = STARLINK_V3.count) {
    this.aboard = count;
    this.total = count;
  }

  /** The payload mass for this many aboard, kg. */
  static massFor(count: number): number {
    return count * STARLINK_V3.mass;
  }

  /** Whether the bay is busy (time must run at physics speed, not on rails). */
  get busy(): boolean {
    return this.state === 'opening' || this.state === 'deploying' || this.state === 'closing';
  }

  /**
   * Each step. missionTime: since T-0 (null before the launch); ship: the ship, once separated;
   * log: the flight log.
   */
  update(t: number, dt: number, missionTime: number | null, ship: Vehicle | undefined, log: (text: string) => void): void {
    this.fly(t);
    if (!ship || ship.status !== 'flight' || missionTime === null) return;
    const firing = ship.engines.some((e) => e.throttle > 0.02 || e.throttleCmd > 0);
    switch (this.state) {
      case 'stowed': {
        // In a stable orbit, engines off, at the planned time.
        if (missionTime < STARLINK_V3.deployAt || firing) break;
        if (orbitApsides(ship.r, ship.v).perigee < 120e3) break;
        this.state = 'opening';
        log(`Payload door opening: ${this.total} Starlink V3 satellites to deploy`);
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
        if (t >= this.nextRelease && !firing) {
          this.release(ship, t);
          log(`Starlink ${this.total - this.aboard} of ${this.total} deployed`);
          this.nextRelease = t + STARLINK_V3.interval;
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
          this.state = 'done';
          log('Payload door closed');
        }
        break;
      default:
        break;
    }
  }

  /** The dispenser pushes the next one out through the door. */
  private release(ship: Vehicle, t: number): void {
    const st = ship.stages[0];
    const xcg = shipCg(ship);
    // The door: on the ship's leeward side (body -y), its middle STARLINK_V3.doorX above the base.
    const out: V3 = qrot(ship.q, [0, -1, 0]);
    // (Its middle starts just inside the hull, its outer edge in the slot: it slides out of it
    // over the next ten seconds or so.)
    const rDoor: V3 = qrot(ship.q, [STARSHIP_V3.xBase + STARLINK_V3.doorX - xcg, -(STARSHIP_V3.radius - STARLINK_V3.width / 2 + 0.2), 0]);
    const wEci = qrot(ship.q, ship.w);
    const vSat = add(add(ship.v, cross(wEci, rDoor)), scale(out, STARLINK_V3.pushSpeed));
    this.aboard--;
    this.lastRelease = t;
    const m = STARLINK_V3.mass;
    const mShip = shipMass(ship);
    st.payload = Math.max(0, payloadOf(st) - m);
    // (The push back on the ship.)
    ship.v = add(ship.v, scale(out, (-m * STARLINK_V3.pushSpeed) / Math.max(mShip - m, 1)));
    const rnd = () => {
      this.seed = (this.seed * 16807) % 2147483647;
      return this.seed / 2147483647 - 0.5;
    };
    this.sats.push({
      n: this.total - this.aboard,
      r: add(ship.r, rDoor),
      v: vSat,
      t,
      released: t,
      q0: [...ship.q],
      // (A slow, uneven tumble from the push: a degree or two a second at most.)
      spin: [rnd() * 0.02, rnd() * 0.012, rnd() * 0.03],
    });
  }

  /** Every satellite on to time t (dropped once long gone). */
  fly(t: number): void {
    for (const s of this.sats) {
      if (s.t >= t) continue;
      const next = propagate(s.r, s.v, s.t, t, { dragArea: 0 }, STARLINK_V3.mass, 10);
      s.r = next.r;
      s.v = next.v;
      s.t = t;
    }
    if (this.sats.length && t - this.sats[0].released > KEEP) this.sats = this.sats.filter((s) => t - s.released <= KEEP);
  }

  /** A satellite's attitude (its axes -> ECI) at time t. */
  static attitude(s: Satellite, t: number): Q {
    const a = (t - s.released);
    const w = norm(s.spin);
    if (w < 1e-9) return s.q0;
    const h = (w * a) / 2;
    const k = Math.sin(h) / w;
    return qmul(s.q0, [Math.cos(h), s.spin[0] * k, s.spin[1] * k, s.spin[2] * k]);
  }
}

/** The ship's mass and centre of mass height (from its stage state). */
function shipCg(ship: Vehicle): number {
  return massProps(ship.stages, ship.stages.map((s) => s.prop)).xcg;
}
function shipMass(ship: Vehicle): number {
  return massProps(ship.stages, ship.stages.map((s) => s.prop)).mass;
}

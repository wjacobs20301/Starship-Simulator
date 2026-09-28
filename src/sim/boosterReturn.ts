// Super Heavy's return to the launch site and catch, as flown on Starship test flights:
//
//   flip       right after hot staging: 13 inner engines at low throttle swing the booster
//              around toward the launch site (staged low in thick air, it first coasts up
//              nose-first until the air is thin enough to turn in)
//   boostback  13 engines at full throttle, aimed by an impact predictor (ballistic flight with
//              drag, then the landing burn simulated) until the predicted landing point nears the
//              tower; then a precise trim on the 3 center engines, from how the landing point
//              moves with the velocity
//   coast      engines off, engines-first, up to apogee and back down. On the way: propellant
//              the landing doesn't need is vented (a heavy booster falls faster and can't hover),
//              a steep fall from high up gets an entry burn to keep the airframe inside its
//              limits, and a course correction burn puts the landing point back on the mount
//              if it has wandered
//   entry      the grid fins steer (small angle of attack) to trim the landing point
//   landing    13-engine landing burn to a hover point beside the arms, lit at the latest moment
//              it works with margin for this booster as it is (landingPlan.ts simulates it
//              ahead), dropping to the 3 center engines once 13 are more than needed
//   catch      slow descent until the catch fins settle on the closing chopsticks
//
// All targeting is done in the pad's rotating ENU frame (padFrame.ts).

import { CN_ALPHA, REF_AREA, axialCoefficient } from './aero';
import { atmosphere } from './atmosphere';
import { DEG, PAD } from './constants';
import type { Aux } from './dynamics';
import { engineThrust, throttleForThrust } from './engine';
import { ecefToGeodetic, eciToEcef, airRelativeVelocity } from './frames';
import { gravityJ2 } from './gravity';
import { applyControl } from './control';
import { type V3, add, clamp, dot, norm, normalize, qrot, scale, sub } from './math';
import { eciDirToPad, eciToPad, eciVelToPad, padDirToEci } from './padFrame';
import { type IgnitionPlan, type Lander, STEER_Q_ALPHA, landingBurn, normalLandingProp, planIgnition, retroCone } from './landingPlan';
import { MOUNTS, catchGap } from './padCollision';
import type { Simulation } from './simulation';
import type { TowerArms } from './tower';
import { type Vehicle, setThrottle } from './vehicle';

/**
 * Catch geometry: the bottom of the booster's catch fittings (the two catch grid fins) above
 * the booster base, from the booster model. The arms' height comes from the tower (tower.ts).
 */
export const CATCH = {
  finBottom: 65.0,
  /** Booster base height when hanging on arms whose rails are at armTop. */
  baseHeight(armTop: number): number {
    return armTop - this.finBottom;
  },
};

/** Catch fins relative to the chopsticks' catch point (pad ENU, m and m/s). */
export interface CatchGuide {
  east: number;
  north: number;
  /** Height of the fins above the arms' rails, m. */
  above: number;
  vel: V3;
  /** Tilt from vertical, deg. */
  tilt: number;
  captureRadius: number;
  armsAngle: number;
  /** Guiding to the ocean target (east / north / above are then relative to it and the water). */
  ocean: boolean;
}

export type ReturnPhase = 'flip' | 'boostback' | 'coast' | 'entry' | 'landing' | 'terminal' | 'caught' | 'lost';

/** Where the booster aims: base centred over the launch mount, just above the arms. */
const HOVER_ABOVE = CATCH.finBottom + 10;
/**
 * Descent into the arms is allowed only with the catch fins inside this radius of the catch
 * point, m; outside it the booster's body is kept above the arms' rails (it would sweep through
 * an arm otherwise).
 */
const ARMS_CORRIDOR = 4;
/** Clearance kept between the booster's base and the arms' rails while outside the corridor, m. */
const ARMS_CLEARANCE = 5;
/**
 * Landing-burn start: the latest moment the burn (simulated ahead, landingPlan.ts) never needs
 * more than this fraction of the engines' thrust. The rest is margin for the unexpected and for
 * steering.
 */
const LANDING_MARGIN = 0.8;
/** Re-plan the landing burn this often while falling (once a second while it's far off), s. */
const PLAN_EVERY = 0.25;
/** Plan the landing only below this height (the fall from here is what the air shapes), m. */
const PLAN_BELOW = 90e3;
/**
 * Entry burn: if falling without one would take the booster above this dynamic pressure (it
 * breaks up at LIMITS.boosterQ, 420 kPa) it slows itself on the way in, until the fall would stay
 * under ENTRY_BURN_Q_END.
 */
const ENTRY_BURN_Q = 300e3;
const ENTRY_BURN_Q_END = 230e3;
/**
 * The entry burn happens between these altitudes (below, the landing burn is next), m, and once
 * falling faster than this (near the top of the arc a burn only hovers), m/s.
 */
const ENTRY_BURN_MIN_ALT = 20e3;
const ENTRY_BURN_MAX_ALT = 80e3;
const ENTRY_BURN_MIN_SPEED = 300;
/** Heaviest the booster may be at the end of the landing burn: its 3 center engines at this throttle hold it. */
const HOVER_THRUST = 0.7;
const PAD_PRESSURE = 101325;
/** Largest steering tilt off retrograde in the entry burn. */
const ENTRY_BURN_TILT = 10 * DEG;
/**
 * Propellant beyond what the landing needs (x this, plus a fixed reserve) is vented on the way
 * down: a heavy booster can't slow down in time, or hover on its 3 center engines.
 */
const PROP_NEED_FACTOR = 1.3;
const PROP_NEED_EXTRA = 20e3;
const VENT_RATE = 30e3; // kg/s
/** Venting starts only for more than this much excess, kg. */
const VENT_HYSTERESIS = 5e3;
const TERMINAL_TILT = 10 * DEG;
/** Stiffer attitude control while landing on 13 engines; gentler on 3 (less gimbal authority). */
const LANDING_GAINS = { wn: 1.4, zeta: 0.9, rollDamp: 0.5 };
/** Final-approach tuning (exported for tests / tuning scripts). */
export const HOVER_TUNING = { wn: 1.6, zeta: 1.0, kp: 0.15, kd: 1.0, byFins: true };
const FIN_TILT_MAX = 12 * DEG;
/**
 * Final trim of the boostback: with less than this velocity change still to make, 3 engines at
 * low throttle (the 13 take a moment to wind down: ~10 m/s more), m/s.
 */
const TRIM_DV = 25;
/**
 * Course correction on the way down: when the predicted miss is over this (m), in air thinner
 * than this (Pa), above this altitude (m).
 */
const CORRECTION_MIN_MISS = 150;
const CORRECTION_Q_MAX = 3e3;
const CORRECTION_MIN_ALT = 30e3;
/** Acceleration range for the trim, m/s^2. */
const TRIM_ACCEL = [1, 8];
/** The landing point's sensitivities are measured within this predicted miss, m. */
const JAC_RANGE = 60e3;
/** Largest offset of the catch fins from the arms' centreline that still catches, m. */
const CAPTURE_RADIUS = 2.5;
const BOOSTBACK_PITCH = 25 * DEG;
/** Dynamic pressure the flip waits for (below the q-alpha limit with the booster broadside), Pa. */
const FLIP_Q_MAX = 15e3;
/** Targeting altitude before the landing burn is planned (roughly where it starts), m. */
const LANDING_TARGET_ALT = 3800;
/** Velocity step for the impact point's sensitivities (the boostback trim), m/s. */
const JAC_DV = 2;
/**
 * Vertical velocity changes cost this much more than horizontal ones in the boostback trim
 * (they change the apogee, and so how hard the entry is).
 */
const TRIM_VERTICAL_WEIGHT = 4;

interface Impact {
  /** Pad ENU position where the trajectory crosses the stop altitude. */
  pos: V3;
  /** Ground-relative velocity there, pad ENU. */
  vel: V3;
  time: number;
}

/**
 * Ballistic flight with drag (engines-first) from the current state until the geodetic altitude
 * drops below `stopAlt` (m above the pad's ground level).
 */
export function predictImpact(r0: V3, v0: V3, t0: number, mass: number, stopAlt: number): Impact | null {
  let r = r0;
  let v = v0;
  let t = t0;
  const accel = (rr: V3, vv: V3, tt: number): V3 => {
    const g = gravityJ2(rr);
    const h = ecefToGeodetic(eciToEcef(rr, tt)).h;
    const atm = atmosphere(h);
    if (atm.rho <= 0) return g;
    const va = airRelativeVelocity(rr, vv);
    const s = norm(va);
    if (s < 1) return g;
    const k = (-0.5 * atm.rho * s * REF_AREA * axialCoefficient(s / atm.a, true)) / mass;
    return add(g, scale(va, k));
  };
  let hPrev = ecefToGeodetic(eciToEcef(r, t)).h - PAD.groundAlt;
  let rPrev = r;
  for (let i = 0; i < 4000; i++) {
    const dt = hPrev > 60e3 ? 2 : hPrev > 10e3 ? 0.5 : 0.25;
    // Midpoint (RK2): plenty for targeting.
    const a1 = accel(r, v, t);
    const rm = add(r, scale(v, dt / 2));
    const vm = add(v, scale(a1, dt / 2));
    const a2 = accel(rm, vm, t + dt / 2);
    rPrev = r;
    r = add(r, scale(vm, dt));
    v = add(v, scale(a2, dt));
    t += dt;
    const h = ecefToGeodetic(eciToEcef(r, t)).h - PAD.groundAlt;
    if (h <= stopAlt) {
      const f = (hPrev - stopAlt) / Math.max(1e-6, hPrev - h);
      const rc = add(rPrev, scale(sub(r, rPrev), f));
      const tc = t - dt * (1 - f);
      return { pos: eciToPad(rc, tc), vel: eciVelToPad(r, v, t), time: tc };
    }
    hPrev = h;
  }
  return null;
}

export class BoosterReturn {
  phase: ReturnPhase = 'flip';
  private closing = false;
  private hovering = false;
  private start: number;
  private nextPredict = 0;
  private impact: Impact | null = null;
  /** The landing burn's predicted remaining range and time, and when predicted. */
  private landEnd: { range: number; time: number; t: number } | null = null;
  /** Where the landing would end, relative to the mount (pad ENU east, north), m. */
  private miss: V3 | null = null;
  private threeEngines = false;
  private trimming = false;
  private lastFin: V3 | null = null;
  private finVel: V3 = [0, 0, 0];
  /** Direction of the predicted miss when the boostback started (to detect overshooting). */
  private missRef: V3 | null = null;
  /** Sensitivity of the miss (east, north) to velocity changes (pad east, north, up), m per m/s. */
  private jac: { J: number[][]; t: number } | null = null;
  /** Velocity added by the engines since the last impact prediction (pad ENU), m/s. */
  private dvSince: V3 = [0, 0, 0];
  /** Smallest velocity change the trim still needed, m/s. */
  private trimDvBest = Infinity;
  /** The landing-burn plan (while falling), and when it was made. */
  private plan: (IgnitionPlan & { t: number; normal: boolean; settled: boolean; keep: number; ventTo: number; entry: number }) | null = null;
  private entryBurn = false;
  private flipWait = false;
  private correcting = false;
  /** Estimate of the propellant it'll keep for the landing, before it's planned. */
  private keepEst: { keep: number; t: number } | null = null;
  private correctFrom = 0;
  private venting = false;
  private vented = 0;
  private ventDone = false;

  constructor(
    private sim: Simulation,
    private log: (text: string) => void,
    /** The catch arms (the launch pad's). */
    private arms: TowerArms,
    /** Which pad it comes home to (0 = Pad 1): positions below are relative to its mount. */
    private pad = 0,
    /**
     * Or a point in the Gulf to land on the water at (pad ENU east / north, m) instead of the
     * tower: positions are then relative to it.
     */
    private ocean: [number, number] | null = null,
  ) {
    this.start = sim.t;
  }

  /** The booster's catch-fin axis (body +z) should lie along the arms' gap. */
  private rollRef(): V3 {
    return padDirToEci(catchGap(this.pad), this.sim.t);
  }

  /** A pad-ENU position relative to the home pad's launch mount (or the ocean target). */
  private rel(p: V3): V3 {
    const [me, mn] = this.ocean ?? MOUNTS[this.pad];
    return [p[0] - me, p[1] - mn, p[2]];
  }

  /** Landing on the water rather than the tower. */
  get toOcean(): boolean {
    return this.ocean !== null;
  }

  /**
   * Height (pad ENU up) the booster's base comes down to: onto the arms at the tower, or the sea
   * at the ocean target (below the pad's level, and lower still for the Earth's curve).
   */
  private get catchBase(): number {
    if (!this.ocean) return CATCH.baseHeight(this.arms.top);
    const d = Math.hypot(this.ocean[0], this.ocean[1]);
    return -PAD.groundAlt - (d * d) / (2 * 6.371e6);
  }

  /** Where the landing burn ends: above the arms, or low over the water. */
  private get hoverHeight(): number {
    return this.catchBase + (this.ocean ? 50 : HOVER_ABOVE);
  }

  update(booster: Vehicle, aux: Aux, dt: number): void {
    const sim = this.sim;
    const t = sim.t;
    const since = t - this.start;
    const posPad = this.rel(eciToPad(booster.r, t));
    const velPad = eciVelToPad(booster.r, booster.v, t);
    const mass = aux.mp.mass;
    // Booster base and catch-fin positions (pad ENU): the CG minus / plus distances along the axis.
    const axisPad = eciDirToPad(this.bodyAxis(booster), t);
    const base = add(posPad, scale(axisPad, -aux.mp.xcg));
    const finPos = add(base, scale(axisPad, CATCH.finBottom));
    const baseHeight = base[2];

    // Refresh the impact prediction a few times a second (it's a full trajectory integration),
    // every cycle while trimming the end of the boostback.
    const fresh = this.phase !== 'landing' && this.phase !== 'terminal' && this.phase !== 'caught' && t >= this.nextPredict;
    if (fresh) {
      this.nextPredict = t + (this.trimming || this.correcting ? 0.1 : 0.25);
      this.impact = predictImpact(booster.r, booster.v, t, mass, this.targetAlt);
      this.dvSince = [0, 0, 0];
      if (this.impact) this.impact.pos = this.rel(this.impact.pos);
      this.miss = this.impact ? this.aimMiss(this.impact, booster, this.aimMass(booster, aux)) : null;
    }
    const miss = this.miss;
    // How the landing point moves with the velocity, for the boostback and course corrections:
    // re-measured every second (from the same moment as the prediction) once it's within reach.
    const boosting = (this.phase === 'flip' || this.phase === 'boostback') && !!miss && Math.hypot(miss[0], miss[1]) < JAC_RANGE;
    if (fresh && miss && (boosting || this.correcting) && (!this.jac || t >= this.jac.t + 1)) {
      this.jac = { J: this.sensitivity(booster, mass, t, miss), t };
    }

    // Plan the landing burn while falling (and the entry burn, and venting, it may call for).
    if ((this.phase === 'coast' || this.phase === 'entry') && velPad[2] < -20 && baseHeight < PLAN_BELOW) {
      if (!this.plan || t >= this.plan.t + (this.plan.in > 10 && !this.entryBurn ? 1 : PLAN_EVERY) || this.plan.in - (t - this.plan.t) < 1) {
        const vh = Math.hypot(velPad[0], velPad[1]);
        const lander = this.landingEngines(booster);
        const p = planIgnition({ z: baseHeight, vh, vz: velPad[2], mass }, this.hoverHeight, lander, LANDING_MARGIN);
        // A normal fall: one that, without a burn, stays well inside the airframe's limits (and
        // that a landing burn can stop).
        const normal = p.ok && p.qBallistic < ENTRY_BURN_Q;
        const settled = p.ok && p.qBallistic < ENTRY_BURN_Q_END;
        // Propellant for the landing: this plan's burn; on a fall that isn't normal, what the
        // burn will take once the fall is (an entry burn having slowed it).
        const landing = normal ? p.burn.prop : normalLandingProp(mass, this.hoverHeight, lander);
        // For an entry burn, what slowing to a fall the airframe takes needs (the peak dynamic
        // pressure goes with the speed squared).
        const entryDv = normal ? 0 : 1.2 * p.vBallistic * Math.max(0, 1 - Math.sqrt(ENTRY_BURN_Q_END / Math.max(1, p.qBallistic)));
        const entry = mass * (1 - Math.exp(-entryDv / (lander.type.ispVac * 9.80665)));
        const keep = landing * PROP_NEED_FACTOR + PROP_NEED_EXTRA + entry;
        // The most it can carry into the landing burn and still hover on its 3 center engines
        // at the end of it.
        const dry = mass - this.propLeft(booster);
        const hoverMass = (HOVER_THRUST * 3 * engineThrust(lander.type, 1, PAD_PRESSURE)) / 9.8;
        const hoverCap = Math.max(0, hoverMass - dry) + landing;
        // Vent down to what's needed; on a fall that isn't normal only what's too heavy to hover
        // with (a fast fall may need more than planned).
        const ventTo = normal ? Math.min(keep, hoverCap) : Math.max(keep, hoverCap);
        this.plan = { ...p, t, normal, settled, keep, ventTo, entry };
      }
    }

    switch (this.phase) {
      case 'flip': {
        // Staged low in thick air: turning broadside would break it up, so it holds nose-first
        // (coasting up out of the thick of it) until the air is thin enough to turn in.
        if (aux.q > FLIP_Q_MAX && velPad[2] > 0 && since < 60) {
          if (!this.flipWait) {
            this.flipWait = true;
            this.log(`Holding for the flip: ${(aux.q / 1000).toFixed(0)} kPa`);
          }
          setThrottle(booster, 'booster', 0);
          applyControl(booster, aux, normalize(airRelativeVelocity(booster.r, booster.v)), dt, undefined, this.rollRef());
          this.start = t - 1.2; // (the flip's timing starts when it turns)
          break;
        }
        // Swing around to face back toward the launch site on the 13 gimballing engines.
        if (since > 1.2) setThrottle(booster, 'booster', 0.4, (ring) => ring <= 1);
        const dir = this.boostbackDir(miss, t);
        applyControl(booster, aux, dir, dt, undefined, this.rollRef());
        const along = dot(normalize(booster.v), dir);
        const facing = dot(this.bodyAxis(booster), dir);
        if ((since > 2 && facing > Math.cos(25 * DEG)) || (since > 25 && along > 0)) {
          this.phase = 'boostback';
          this.log('Boostback burn startup');
        }
        break;
      }

      case 'boostback': {
        // How the landing point moves with the velocity, re-measured every second once it's
        // within reach; between predictions the landing point is moved on by the thrust since.
        const J = this.jac?.J;
        const missNow = this.missNow(miss);
        const d = missNow ? Math.hypot(missNow[0], missNow[1]) : Infinity;
        // The velocity change still needed to put the landing point on the mount.
        const dv = J && missNow ? this.trimDv(J, missNow) : null;
        const need = dv ? norm(dv) : Infinity;
        // The last few m/s on the 3 center engines at low throttle, so the cutoff is precise.
        if (!this.trimming && need < TRIM_DV) {
          this.trimming = true;
        }
        let done = false;
        if (this.trimming && dv) {
          done = this.trimStep(booster, aux, dv, axisPad, dt);
        } else {
          applyControl(booster, aux, this.boostbackDir(missNow, t), dt, undefined, this.rollRef());
          setThrottle(booster, 'booster', 1, (ring) => ring <= 1);
          if (missNow && !this.missRef) this.missRef = normalize(missNow);
          // Overshot on the main burn (the trim should have taken over before this).
          done = !!(missNow && this.missRef && dot(missNow, this.missRef) < 0);
        }
        if (done || this.propLeft(booster) < this.landingReserve(booster, aux)) {
          setThrottle(booster, 'booster', 0);
          this.trimming = false;
          this.phase = 'coast';
          this.log(`Boostback burn shutdown (predicted miss ${(d / 1000).toFixed(2)} km)`);
        }
        break;
      }

      case 'coast':
      case 'entry': {
        // Engines-first, with the grid fins trimming the landing point once the air is thick enough.
        const retro = normalize(scale(airRelativeVelocity(booster.r, booster.v), -1));
        let target = retro;
        const roll = this.rollRef();
        if (aux.q > 2e3 && miss) {
          if (this.phase === 'coast') {
            this.phase = 'entry';
            this.log('Grid fins steering');
          }
          const d = Math.hypot(miss[0], miss[1]);
          // Tilting the top toward the miss pushes the booster the other way (body lift).
          // q-alpha limit: steer no harder than a side load the airframe carries with margin.
          const tiltMax = Math.min(FIN_TILT_MAX, Math.asin(Math.min(1, STEER_Q_ALPHA / aux.q)));
          const tilt = clamp(d / 300, 0, 1) * tiltMax;
          if (d > 1) {
            target = normalize(add(retro, scale(padDirToEci([miss[0] / d, miss[1] / d, 0], t), Math.tan(tilt))));
          }
        }
        // Course correction: high up, where it's cheap, a small burn puts the landing point back
        // on the mount if it has wandered (after an entry burn, say).
        // (Not while an entry burn is due: that comes first; nor while venting, which moves the
        // landing point as the booster gets lighter.)
        const canCorrect =
          aux.q < CORRECTION_Q_MAX && aux.geo.h > CORRECTION_MIN_ALT && !this.entryBurn && !this.venting && this.plan?.normal !== false && this.propLeft(booster) > (this.plan?.keep ?? this.landingReserve(booster, aux));
        const missNow = this.missNow(miss);
        const dMiss = missNow ? Math.hypot(missNow[0], missNow[1]) : 0;
        if (!this.correcting && canCorrect && dMiss > CORRECTION_MIN_MISS) {
          this.correcting = true;
          this.correctFrom = t;
          this.trimDvBest = Infinity;
          this.log(`Course correction burn (predicted miss ${(dMiss / 1000).toFixed(2)} km)`);
        }
        if (this.correcting) {
          const J = this.jac && this.jac.t >= this.correctFrom ? this.jac.J : null;
          let done = !canCorrect;
          if (J && missNow) done ||= this.trimStep(booster, aux, this.trimDv(J, missNow), axisPad, dt);
          else setThrottle(booster, 'booster', 0);
          if (done) {
            this.correcting = false;
            setThrottle(booster, 'booster', 0);
            this.log(`Course correction complete (predicted miss ${(dMiss / 1000).toFixed(2)} km)`);
          } else break;
        }
        this.entryBurnAndVent(booster, aux, velPad[2], dt);
        if (this.entryBurn && miss) {
          // Entry burn: retrograde, leaning to hold the landing point on the mount (pushing the
          // other way to the miss).
          const d = Math.hypot(miss[0], miss[1]);
          const cone = retroCone(aux.q);
          const tilt = Math.min(clamp(d / 2000, 0, 1) * ENTRY_BURN_TILT, cone ?? Infinity);
          target = d > 1 ? normalize(add(retro, scale(padDirToEci([-miss[0] / d, -miss[1] / d, 0], t), Math.tan(tilt)))) : retro;
        }
        applyControl(booster, aux, target, dt, undefined, roll);
        if (this.shouldIgnite(t)) {
          if (this.entryBurn) this.endEntryBurn();
          if (this.venting) this.endVent();
          setThrottle(booster, 'booster', 1, (ring) => ring <= 1);
          this.phase = 'landing';
          this.log(`Landing burn startup (${(baseHeight / 1000).toFixed(1)} km, ${(norm(velPad) * 3.6).toFixed(0)} km/h)`);
        }
        break;
      }

      case 'landing':
      case 'terminal': {
        // Guidance targets the base, not the CG.
        const catchBase = this.catchBase;
        const hover: V3 = [0, 0, this.hoverHeight];
        // aCmd: the bulk (braking) acceleration; aCorr: the sideways correction on top.
        let aCmd: V3;
        let aCorr: V3;
        if (this.phase === 'landing') {
          // Retrograde ("gravity turn") landing burn: braking along the velocity slows the
          // horizontal and vertical speeds together, so the booster flies a straight line and
          // stops where its velocity vector points. The vertical plan sets the deceleration
          // (arrive at the hover point still descending at ~4 m/s); a small horizontal correction
          // moves that end point onto the mount.
          const h = Math.max(1, baseHeight - hover[2]);
          const vz = Math.max(1, -velPad[2]);
          const aDec = Math.max(0, vz * vz - 16) / (2 * h);
          // Where the burn, carried on as it is, ends (simulated a few times a second: drag, and
          // the engines' minimum thrust, bend it away from a straight line).
          const vh = Math.hypot(velPad[0], velPad[1]);
          if (!this.landEnd || t >= this.landEnd.t + 0.2) {
            const run = { throttle: booster.engines[0].throttle, few: this.threeEngines };
            const burn = landingBurn({ z: baseHeight, vh, vz: velPad[2], mass }, this.hoverHeight, this.landingEngines(booster), run);
            this.landEnd = { range: burn.range, time: burn.time, t };
          }
          const k = vh > 1e-3 ? Math.max(0, this.landEnd.range - vh * (t - this.landEnd.t)) / vh : 0;
          const tg = Math.max(0, this.landEnd.time - (t - this.landEnd.t));
          const errX = posPad[0] + velPad[0] * k;
          const errY = posPad[1] + velPad[1] * k;
          // (With a floor on the time left: re-aimed at the end point over the last seconds, the
          // correction yanks and swings the booster through it. And no harder than the side load
          // the airframe carries at this dynamic pressure.)
          const tgC = Math.max(4, tg);
          const qTilt = aux.q > 1e3 ? Math.asin(Math.min(1, STEER_Q_ALPHA / aux.q)) : Math.PI / 2;
          const cMax = Math.min(10, (aDec + 9.8) * Math.tan(Math.min(10 * DEG, qTilt)));
          const corr = (e: number) => clamp((-2 * e) / (tgC * tgC), -cMax, cMax);
          aCmd = [(-velPad[0] * aDec) / vz, (-velPad[1] * aDec) / vz, aDec + 9.8];
          // (Over the water the last few hundred metres are straight retrograde: no re-aiming, so
          // it arrives with the sideways speed gone rather than exactly on the mark.)
          aCorr = this.ocean && h < 600 ? [0, 0, 0] : [corr(errX), corr(errY), 0];
          if (h < 15 || norm(velPad) < 8) {
            this.phase = 'terminal';
          }
        } else if (this.ocean) {
          // Over the water: settle straight down onto it, slowing to ~1.5 m/s, holding position
          // over the target.
          if (!this.hovering) {
            this.hovering = true;
            this.log('Final descent to the water');
          }
          const above = baseHeight - catchBase;
          const vzCmd = -clamp(0.08 * above + 1.2, 1.2, 4);
          aCmd = [0, 0, 1.4 * (vzCmd - velPad[2]) + 9.79];
          // (Stopping the drift matters more than the last few metres: a sideways touchdown on
          // the water tips it over. The position pull is capped at a gentle drift.)
          const pull = (x: number) => -clamp(0.08 * x, -1.5, 1.5);
          aCorr = [1.2 * (pull(posPad[0]) - velPad[0]), 1.2 * (pull(posPad[1]) - velPad[1]), 0];
        } else {
          // Hold height until centred over the mount (three Raptors at minimum throttle only just
          // let it hover), then descend, slowing from ~4 to ~1.5 m/s onto the arms.
          // Horizontal control acts on the CG: steering the base would fight the tilt.
          // Steer by the catch fins, not the CG: they're what meets the arms, and near the top
          // they move the right way at once when the booster tilts (the base swings the other
          // way first, which with 3 engines makes a CG loop wobble).
          const finVel = this.finVelocity(finPos, dt);
          const offNow = Math.hypot(finPos[0], finPos[1]);
          if (!this.hovering && norm(velPad) < 6 && offNow < ARMS_CORRIDOR) {
            this.hovering = true;
            this.log(`Final approach: hovering ${(finPos[2] - this.arms.top).toFixed(0)} m above the arms`);
          }
          const off = Math.hypot(finPos[0], finPos[1]);
          const drift = Math.hypot(finVel[0], finVel[1]);
          const aboveArms = baseHeight - catchBase;
          // Descend while lined up (or still well above the arms); pause if it drifts off.
          // Over the arms' opening, descend (the last 25 m only when lined up and steady); outside
          // it, stay (or climb back) above the rails so the body can't sweep through an arm.
          const inCorridor = off < ARMS_CORRIDOR;
          const clear = baseHeight - (this.arms.top + ARMS_CLEARANCE);
          const go = inCorridor && (aboveArms > 25 || (off < 1.2 && drift < 0.6));
          const vzCmd = go ? -clamp(0.1 * aboveArms + 1.5, 1.5, 4) : !inCorridor && clear < 0 ? clamp(-0.5 * clear, 0.5, 3) : 0;
          // Position loop well inside the attitude loop's bandwidth.
          aCmd = [0, 0, 1.4 * (vzCmd - velPad[2]) + 9.79];
          const ref = HOVER_TUNING.byFins ? finPos : posPad;
          const refV = HOVER_TUNING.byFins ? finVel : velPad;
          aCorr = [-HOVER_TUNING.kp * ref[0] - HOVER_TUNING.kd * refV[0], -HOVER_TUNING.kp * ref[1] - HOVER_TUNING.kd * refV[1], 0];
        }
        // Remove the drag we're already getting (engines-first, it's a big help early on).
        const sp = norm(velPad);
        if (sp > 1) aCmd = add(aCmd, scale(velPad, this.dragAccel(aux, sp) / sp));
        if (aCmd[2] < 0.5) aCmd[2] = 0.5;
        const force = mass * norm(aCmd);
        // Sideways correction by tilting. What a tilt buys is the thrust's sideways component
        // minus the body's and grid fins' lift, which pushes the other way: in thick air (early
        // in the burn) lift wins and the tilt must go the opposite way.
        const bulk = normalize(aCmd);
        const lateral = sub(aCorr, scale(bulk, dot(aCorr, bulk)));
        const perRad = (force - aux.q * this.liftPerRad(booster)) / mass;
        let tilt: V3 = Math.abs(perRad) > 3 ? scale(lateral, 1 / perRad) : [0, 0, 0];
        // (And never more than the side load the airframe takes at this dynamic pressure.)
        const qLimit = aux.q > 1e3 ? Math.asin(Math.min(1, STEER_Q_ALPHA / aux.q)) : Math.PI / 2;
        const maxTilt = Math.tan(Math.min(qLimit, this.phase === 'terminal' ? TERMINAL_TILT : 8 * DEG));
        if (norm(tilt) > maxTilt) tilt = scale(tilt, maxTilt / norm(tilt));
        let thrustDir = normalize(add(bulk, tilt));
        // In thick fast air the booster must also stay close to engines-first: however the thrust
        // is best pointed, it's kept within the side-load limit of retrograde.
        const cone = retroCone(aux.q);
        if (sp > 1 && cone !== null) thrustDir = coneLimit(thrustDir, scale(velPad, -1 / sp), cone);
        const perEngine = engineThrust(booster.engines[0].place.type, 1, aux.pAmb);
        // Down to the 3 center engines once they can carry the rest of the landing with margin
        // (and it's slow: early on, drag does much of the braking and fades as it slows).
        if (!this.threeEngines && force < 0.75 * 3 * perEngine && norm(velPad) < 120) {
          this.threeEngines = true;
          setThrottle(booster, 'booster', 0, (ring) => ring === 1);
          this.log('Inner ring shutdown: 3 engines for the catch');
        }
        const n = this.threeEngines ? 3 : 13;
        const throttle = throttleForThrust(booster.engines[0].place.type, force / n, aux.pAmb);
        setThrottle(booster, 'booster', clamp(throttle, 0.4, 1), (ring) => (this.threeEngines ? ring === 0 : ring <= 1));
        const gains = this.threeEngines ? { wn: HOVER_TUNING.wn, zeta: HOVER_TUNING.zeta, rollDamp: 0.5 } : LANDING_GAINS;
        applyControl(booster, aux, padDirToEci(thrustDir, t), dt, gains, this.rollRef());

        if (!this.ocean) this.checkCatch(booster, finPos, velPad, axisPad, this.phase === 'terminal');
        if (this.propLeft(booster) <= 0 && (this.phase as ReturnPhase) !== 'caught') this.phase = 'lost';
        break;
      }

      case 'caught':
        // Hanging on the arms (the sim moves it with them: simulation.ts hang()).
        break;

      case 'lost':
        setThrottle(booster, 'booster', 0);
        applyControl(booster, aux, null, dt);
        break;
    }
    // Velocity the thrust adds this step (for moving the landing point on between predictions).
    this.dvSince = add(this.dvSince, scale(axisPad, (aux.thrust / mass) * dt));
  }

  /** The last predicted miss, moved on by the thrust since (through the sensitivities). */
  private missNow(miss: V3 | null): V3 | null {
    const J = this.jac?.J;
    return miss && J ? [miss[0] + dot(J[0] as V3, this.dvSince), miss[1] + dot(J[1] as V3, this.dvSince), 0] : miss;
  }

  /**
   * One step of a precise trim burn: the velocity change `dv` (pad ENU) that puts the landing
   * point on the mount, gently (~2 s for what's left) on the 3 center engines (or the 13, for a
   * heavy booster), burning only while pointed along it. True once it's done.
   */
  private trimStep(booster: Vehicle, aux: Aux, dv: V3, axisPad: V3, dt: number): boolean {
    const t = this.sim.t;
    const mass = aux.mp.mass;
    const need = norm(dv);
    const dirPad = need > 1e-6 ? scale(dv, 1 / need) : axisPad;
    // (It can swing round as a main burn tails off.)
    const aligned = dot(axisPad, dirPad) > Math.cos(10 * DEG);
    const type = booster.engines[0].place.type;
    const aWant = clamp(need / 2, TRIM_ACCEL[0], TRIM_ACCEL[1]);
    const n = (3 * engineThrust(type, 1, aux.pAmb)) / mass >= aWant ? 3 : 13;
    const throttle = clamp(throttleForThrust(type, (aWant * mass) / n, aux.pAmb), type.minThrottle, 1);
    setThrottle(booster, 'booster', 0, (ring) => ring > (n === 3 ? 0 : 1));
    setThrottle(booster, 'booster', aligned ? throttle : 0, (ring) => ring <= (n === 3 ? 0 : 1));
    if (this.jac && this.jac.t === t) this.trimDvBest = Infinity; // (re-measured: start over)
    if (aligned) this.trimDvBest = Math.min(this.trimDvBest, need);
    applyControl(booster, aux, normalize(padDirToEci(dirPad, t)), dt, undefined, this.rollRef());
    // Done when what's left is less than a moment's thrust (or it has started growing again).
    const aSet = (n * engineThrust(type, throttle, aux.pAmb)) / mass;
    return need < Math.max(0.05, 1.5 * aSet * dt) || (!aligned && need < 0.3) || (aligned && need > this.trimDvBest + 0.5);
  }

  /**
   * Chopsticks close as the booster settles in beside them (the tower's operators do this,
   * whoever flies the booster), then catch it, or it hits them.
   */
  private checkCatch(booster: Vehicle, finPos: V3, velPad: V3, axisPad: V3, settled: boolean): void {
    const fins = finPos[2];
    const offset = Math.hypot(finPos[0], finPos[1]);
    const armTop = this.arms.top;
    if (!this.closing && settled && fins < armTop + 12 && fins > armTop - 1 && offset < CAPTURE_RADIUS && norm(velPad) < 5) {
      this.closing = true;
      this.arms.command({ angle: 0 });
      this.log('Chopsticks closing');
    }
    if (fins <= armTop + 0.05) {
      const tilt = Math.acos(clamp(axisPad[2], -1, 1));
      // The catch fittings (under the grid fins, body +-z) have to come down across the gap onto the rails.
      const z = eciDirToPad(qrot(booster.q, [0, 0, 1]), this.sim.t);
      const gap = catchGap(this.pad);
      const zh = Math.hypot(z[0], z[1]);
      const roll = Math.acos(clamp(zh > 1e-6 ? Math.abs(z[0] * gap[0] + z[1] * gap[1]) / zh : 0, 0, 1));
      // The closing arms push the booster to the centre: a couple of metres off still catches.
      // Closed = both arms pressed against the booster (they stop there, padCollision.ts).
      const closed = this.arms.contact && !this.arms.moving;
      if (closed && offset < CAPTURE_RADIUS && Math.abs(velPad[2]) < 2.5 && tilt < 3 * DEG && roll < 8 * DEG) {
        setThrottle(booster, 'booster', 0);
        this.phase = 'caught';
        booster.status = 'caught';
        booster.caughtPad = this.pad;
        booster.catchPin = CATCH.finBottom;
        this.log(`Booster caught! (${offset.toFixed(2)} m off center, ${Math.abs(velPad[2]).toFixed(1)} m/s)`);
      } else if (fins < armTop - 1.5 && offset < 12 && this.arms.contact) {
        setThrottle(booster, 'booster', 0);
        this.phase = 'lost';
        booster.status = 'destroyed';
        this.log(roll >= 8 * DEG ? `Booster's catch fittings missed the rails (rolled ${(roll / DEG).toFixed(0)}° off)` : 'Booster struck the chopsticks');
      }
    }
  }

  /** Booster base and catch-fin positions and velocity in pad ENU. */
  private catchGeometry(booster: Vehicle, aux: Aux): { posPad: V3; velPad: V3; axisPad: V3; finPos: V3; base: V3 } {
    const t = this.sim.t;
    const posPad = this.rel(eciToPad(booster.r, t));
    const velPad = eciVelToPad(booster.r, booster.v, t);
    const axisPad = eciDirToPad(this.bodyAxis(booster), t);
    const base = add(posPad, scale(axisPad, -aux.mp.xcg));
    const finPos = add(base, scale(axisPad, CATCH.finBottom));
    return { posPad, velPad, axisPad, finPos, base };
  }

  /**
   * The player is flying the booster: nothing is steered for them, but the tower still closes
   * its arms on a booster that settles in, and catches (or is hit by) it.
   */
  watchCatch(booster: Vehicle, aux: Aux): void {
    if (this.phase === 'caught' || this.phase === 'lost' || this.ocean) return;
    const g = this.catchGeometry(booster, aux);
    const offset = Math.hypot(g.finPos[0], g.finPos[1]);
    const settled = offset < CAPTURE_RADIUS && Math.abs(g.velPad[2]) < 3 && Math.hypot(g.velPad[0], g.velPad[1]) < 1.5;
    this.checkCatch(booster, g.finPos, g.velPad, g.axisPad, settled);
  }

  /**
   * Target hold for a player-flown booster: lean the thrust toward the catch point (catch fins
   * over the arms' centre), damping the drift, like the autopilot's final approach; catch fins
   * facing the arms' gap.
   */
  targetHold(booster: Vehicle, aux: Aux, dt: number): { dir: V3; rollRef: V3 } {
    const g = this.catchGeometry(booster, aux);
    const finVel = this.finVelocity(g.finPos, dt);
    const kp = HOVER_TUNING.kp / 9.8;
    const kd = HOVER_TUNING.kd / 9.8;
    let lean: V3 = [-(kp * g.finPos[0] + kd * finVel[0]), -(kp * g.finPos[1] + kd * finVel[1]), 0];
    const l = Math.hypot(lean[0], lean[1]);
    const max = Math.tan(TERMINAL_TILT);
    if (l > max) lean = scale(lean, max / l);
    const t = this.sim.t;
    return { dir: normalize(padDirToEci(normalize([lean[0], lean[1], 1]), t)), rollRef: this.rollRef() };
  }

  /** Where the catch fins are relative to the chopsticks, for the player's catch display. */
  guide(booster: Vehicle, aux: Aux): CatchGuide {
    const g = this.catchGeometry(booster, aux);
    return {
      east: this.ocean ? g.base[0] : g.finPos[0],
      north: this.ocean ? g.base[1] : g.finPos[1],
      above: this.ocean ? g.base[2] - this.catchBase : g.finPos[2] - this.arms.top,
      vel: g.velPad,
      tilt: Math.acos(clamp(g.axisPad[2], -1, 1)) / DEG,
      captureRadius: CAPTURE_RADIUS,
      armsAngle: this.arms.angle,
      ocean: this.ocean !== null,
    };
  }

  /** Catch-fin velocity (pad ENU) by finite differences, lightly smoothed. */
  private finVelocity(fin: V3, dt: number): V3 {
    const prev = this.lastFin;
    this.lastFin = fin;
    if (!prev) return [0, 0, 0];
    const raw: V3 = [(fin[0] - prev[0]) / dt, (fin[1] - prev[1]) / dt, (fin[2] - prev[2]) / dt];
    const k = Math.min(1, dt / 0.15);
    this.finVel = add(scale(this.finVel, 1 - k), scale(raw, k));
    return this.finVel;
  }

  /** Sideways aerodynamic force per radian of angle of attack, per unit dynamic pressure, m^2. */
  private liftPerRad(v: Vehicle): number {
    const fins = v.stages[0].def.gridFins?.area ?? 0;
    return REF_AREA * CN_ALPHA + fins * 1.1;
  }

  /** Engines-first drag acceleration at this speed and height, m/s^2. */
  private dragAccel(aux: Aux, speed: number): number {
    return (0.5 * aux.rho * speed * speed * REF_AREA * axialCoefficient(aux.mach, true)) / aux.mp.mass;
  }

  /** The booster for landing planning: the 13 gimballing engines, finishing on the 3 center ones. */
  private landingEngines(booster: Vehicle): Lander {
    return { type: booster.engines[0].place.type, many: 13, few: 3, liftPerRad: this.liftPerRad(booster) };
  }

  /** Light the landing burn: the plan says now is the last moment it works with margin. */
  private shouldIgnite(t: number): boolean {
    const p = this.plan;
    return !!p && p.in - (t - p.t) <= 0.02;
  }

  /** Where the landing trajectory crosses the targeting altitude: the planned ignition height. */
  private get targetAlt(): number {
    return this.plan ? clamp(this.plan.z, 1500, 40e3) : LANDING_TARGET_ALT;
  }

  /**
   * Aim point: where the landing burn will end. The prediction runs to where the burn lights;
   * from there the burn (simulated) carries on along the horizontal velocity for some distance
   * before stopping at the hover height. That end point is what has to sit over the mount.
   */
  private aimMiss(imp: Impact, booster: Vehicle, mass: number): V3 {
    const vh = Math.hypot(imp.vel[0], imp.vel[1]);
    if (vh < 1e-3) return [imp.pos[0], imp.pos[1], 0];
    const burn = landingBurn({ z: imp.pos[2], vh, vz: imp.vel[2], mass }, this.hoverHeight, this.landingEngines(booster));
    const k = burn.range / vh;
    return [imp.pos[0] + imp.vel[0] * k, imp.pos[1] + imp.vel[1] * k, 0];
  }

  /**
   * The booster's mass when the landing burn lights (what the aim point is worked out for):
   * dry plus the propellant it'll have kept by then.
   */
  private aimMass(booster: Vehicle, aux: Aux): number {
    const prop = this.propLeft(booster);
    const dry = aux.mp.mass - prop;
    if (this.plan) return dry + Math.min(prop, this.plan.ventTo);
    if (!this.keepEst || this.sim.t >= this.keepEst.t + 5) {
      const lander = this.landingEngines(booster);
      const keep = normalLandingProp(aux.mp.mass, this.hoverHeight, lander) * PROP_NEED_FACTOR + PROP_NEED_EXTRA;
      this.keepEst = { keep, t: this.sim.t };
    }
    return dry + Math.min(prop, this.keepEst.keep);
  }

  /** How the aim point (east, north) moves per m/s of velocity change along pad east, north, up. */
  private sensitivity(booster: Vehicle, mass: number, t: number, miss: V3): number[][] {
    const J = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let k = 0; k < 3; k++) {
      const e: V3 = [0, 0, 0];
      e[k] = JAC_DV;
      const imp = predictImpact(booster.r, add(booster.v, padDirToEci(e, t)), t, mass, this.targetAlt);
      if (!imp) continue;
      imp.pos = this.rel(imp.pos);
      const m = this.aimMiss(imp, booster, this.aimMass(booster, this.sim.aux.get('booster')!));
      J[0][k] = (m[0] - miss[0]) / JAC_DV;
      J[1][k] = (m[1] - miss[1]) / JAC_DV;
    }
    return J;
  }

  /**
   * Smallest velocity change (pad ENU; vertical changes weighted as costlier) that moves the aim
   * point onto the mount: dv = W^-1 J^T (J W^-1 J^T)^-1 (-miss).
   */
  private trimDv(J: number[][], miss: V3): V3 {
    const w = [1, 1, 1 / TRIM_VERTICAL_WEIGHT];
    const a = J[0][0] * J[0][0] * w[0] + J[0][1] * J[0][1] * w[1] + J[0][2] * J[0][2] * w[2];
    const b = J[0][0] * J[1][0] * w[0] + J[0][1] * J[1][1] * w[1] + J[0][2] * J[1][2] * w[2];
    const c = J[1][0] * J[1][0] * w[0] + J[1][1] * J[1][1] * w[1] + J[1][2] * J[1][2] * w[2];
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-9) return [0, 0, 0];
    const [mx, my] = [-miss[0], -miss[1]];
    const y0 = (c * mx - b * my) / det;
    const y1 = (-b * mx + a * my) / det;
    return [0, 1, 2].map((k) => w[k] * (J[0][k] * y0 + J[1][k] * y1)) as V3;
  }

  /**
   * On the way down: an entry burn if the fall would be too hard on the airframe, and venting of
   * propellant the landing doesn't need (a heavy booster falls faster and can't hover).
   */
  private entryBurnAndVent(booster: Vehicle, aux: Aux, vz: number, dt: number): void {
    const plan = this.plan;
    if (!plan) return;
    const prop = this.propLeft(booster);
    const { normal, settled, ventTo } = plan;
    const high = aux.geo.h > ENTRY_BURN_MIN_ALT;

    // Propellant beyond what's needed goes overboard first (a heavy booster falls faster, and
    // can't hover).
    const excess = prop - ventTo;
    if (!this.entryBurn && (excess > VENT_HYSTERESIS || (this.venting && excess > 0))) {
      if (!this.venting) {
        this.venting = true;
        // (Topping up later, a few tonnes at a time, isn't news.)
        if (this.vented === 0) this.log('Venting excess propellant');
      }
      const v = Math.min(excess, VENT_RATE * dt);
      booster.stages[0].prop -= v;
      this.vented += v;
      return;
    }
    if (this.venting) this.endVent();

    if (!this.entryBurn && !normal && high && aux.geo.h < ENTRY_BURN_MAX_ALT && vz < -ENTRY_BURN_MIN_SPEED && prop > plan.keep - plan.entry) {
      // Too fast for that (a steep fall from high up): an entry burn slows it high up.
      this.entryBurn = true;
      setThrottle(booster, 'booster', 1, (ring) => ring <= 1);
      this.log(`Entry burn startup (${(aux.geo.h / 1000).toFixed(0)} km)`);
    } else if (this.entryBurn && (settled || prop <= plan.keep - plan.entry)) {
      this.endEntryBurn();
    }
  }

  private endEntryBurn(): void {
    this.entryBurn = false;
    setThrottle(this.sim.find('booster')!, 'booster', 0);
    this.log('Entry burn shutdown');
  }

  private endVent(): void {
    this.venting = false;
    if (!this.ventDone) this.log(`Venting complete (${(this.vented / 1000).toFixed(0)} t)`);
    this.ventDone = true;
  }

  /** Horizontal thrust direction (pad ENU) for the boostback: pull the impact point to the tower. */
  private boostbackDirPad(miss: V3 | null): V3 {
    if (!miss || Math.hypot(miss[0], miss[1]) < 1) return [-1, 0, 0];
    const d = Math.hypot(miss[0], miss[1]);
    // Pitched a little below the horizon: trims the vertical speed, so a lower apogee and a
    // gentler entry.
    const c = Math.cos(BOOSTBACK_PITCH);
    return [(-miss[0] / d) * c, (-miss[1] / d) * c, -Math.sin(BOOSTBACK_PITCH)];
  }

  private boostbackDir(miss: V3 | null, t: number): V3 {
    return normalize(padDirToEci(this.boostbackDirPad(miss), t));
  }

  private bodyAxis(v: Vehicle): V3 {
    const q = v.q;
    // Body +x in ECI.
    return [
      1 - 2 * (q[2] * q[2] + q[3] * q[3]),
      2 * (q[1] * q[2] + q[0] * q[3]),
      2 * (q[1] * q[3] - q[0] * q[2]),
    ];
  }

  private propLeft(v: Vehicle): number {
    return v.stages[0].prop;
  }

  /** Propellant to keep for the landing burn: enough for ~450 m/s of delta-v, kg. */
  private landingReserve(v: Vehicle, aux: Aux): number {
    const dry = aux.mp.mass - v.stages[0].prop;
    return dry * (Math.exp(450 / (350 * 9.80665)) - 1);
  }
}

/** `dir` turned toward `axis` (both unit) as needed to lie within `maxAngle` of it. */
function coneLimit(dir: V3, axis: V3, maxAngle: number): V3 {
  const c = clamp(dot(dir, axis), -1, 1);
  const angle = Math.acos(c);
  if (angle <= maxAngle) return dir;
  const perp = sub(dir, scale(axis, c));
  const pn = norm(perp);
  if (pn < 1e-9) return axis;
  return add(scale(axis, Math.cos(maxAngle)), scale(perp, Math.sin(maxAngle) / pn));
}

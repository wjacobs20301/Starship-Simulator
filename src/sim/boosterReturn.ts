// Super Heavy's return to the launch site and catch, as flown on Starship test flights:
//
//   flip       right after hot staging: 13 inner engines at low throttle swing the booster
//              around toward the launch site
//   boostback  13 engines at full throttle, aimed by an impact predictor (ballistic flight with
//              drag) until the predicted landing point reaches the tower
//   coast      engines off, engines-first, up to apogee and back down
//   entry      the grid fins steer (small angle of attack) to trim the landing point
//   landing    13-engine landing burn under ZEM/ZEV guidance to a hover point beside the arms,
//              dropping to the 3 center engines once 13 are more than needed
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
/** Landing-burn start: planned net deceleration as a fraction of 13 engines' capability. */
const LANDING_PLAN = 0.5;
/** How much of the drag at the moment of deciding to light the landing burn counts toward stopping. */
const IGNITE_DRAG_CREDIT = 0.5;
const TERMINAL_TILT = 10 * DEG;
/** Stiffer attitude control while landing on 13 engines; gentler on 3 (less gimbal authority). */
const LANDING_GAINS = { wn: 1.4, zeta: 0.9, rollDamp: 0.5 };
/** Final-approach tuning (exported for tests / tuning scripts). */
export const HOVER_TUNING = { wn: 1.6, zeta: 1.0, kp: 0.15, kd: 1.0, byFins: true };
const FIN_TILT_MAX = 12 * DEG;
/** Side load (q x sin(angle of attack), Pa) the fin steering stays under: a quarter of the structural limit. */
const STEER_Q_ALPHA = 10e3;
/** Final trim of the boostback: within this predicted miss, 3 engines at low throttle. */
const TRIM_RANGE = 5000;
/** Largest offset of the catch fins from the arms' centreline that still catches, m. */
const CAPTURE_RADIUS = 2.5;
const BOOSTBACK_PITCH = 25 * DEG;
/** Targeting altitude (roughly where the landing burn starts), m. */
const LANDING_TARGET_ALT = 3800;

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
  private threeEngines = false;
  private trimming = false;
  /** Smallest predicted miss seen during the boostback trim, m. */
  private trimBest = Infinity;
  private lastFin: V3 | null = null;
  private finVel: V3 = [0, 0, 0];
  /** Direction of the predicted miss when the boostback started (to detect overshooting). */
  private missRef: V3 | null = null;

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
    if (this.phase !== 'landing' && this.phase !== 'terminal' && this.phase !== 'caught' && t >= this.nextPredict) {
      this.nextPredict = t + (this.trimming ? 0 : 0.25);
      this.impact = predictImpact(booster.r, booster.v, t, mass, LANDING_TARGET_ALT);
      if (this.impact) this.impact.pos = this.rel(this.impact.pos);
    }
    // Aim point: where the landing burn will end. The prediction runs to about where the burn
    // lights; from there a retrograde burn flies a straight line along its velocity, stopping
    // at the hover height. That end point is what has to sit over the mount.
    let miss: V3 | null = null;
    if (this.impact) {
      const hover = this.hoverHeight;
      const drop = Math.max(0, this.impact.pos[2] - hover);
      const s = drop / Math.max(1, -this.impact.vel[2]);
      miss = [this.impact.pos[0] + this.impact.vel[0] * s, this.impact.pos[1] + this.impact.vel[1] * s, 0];
    }

    switch (this.phase) {
      case 'flip': {
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
        const dir = this.boostbackDir(miss, t);
        applyControl(booster, aux, dir, dt, undefined, this.rollRef());
        const d = miss ? Math.hypot(miss[0], miss[1]) : Infinity;
        // Trim the last few kilometres on the 3 center engines so the cutoff is precise.
        if (d < TRIM_RANGE && !this.trimming) {
          this.trimming = true;
          setThrottle(booster, 'booster', 0, (ring) => ring === 1);
          // From here the whole miss counts, crossrange too (the burn so far mostly killed the
          // downrange part): overshoot is judged against the miss as it stands now.
          if (miss) this.missRef = normalize(miss);
        }
        if (this.trimming) setThrottle(booster, 'booster', 0.4, (ring) => ring === 0);
        else setThrottle(booster, 'booster', 1, (ring) => ring <= 1);
        if (miss && !this.missRef) this.missRef = normalize(miss);
        // Closest approach passed during the trim: the miss has started growing again.
        if (this.trimming) this.trimBest = Math.min(this.trimBest, d);
        const passed = this.trimming && d > this.trimBest + 25;
        const overshot = (miss && this.missRef && dot(miss, this.missRef) < 0) || passed;
        if (d < 150 || overshot || this.propLeft(booster) < this.landingReserve(booster, aux)) {
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
        applyControl(booster, aux, target, dt, undefined, roll);
        if (this.shouldIgnite(booster, aux, velPad, baseHeight)) {
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
          const tg = (2 * h) / vz;
          const aDec = Math.max(0, vz * vz - 16) / (2 * h);
          const errX = posPad[0] + (velPad[0] * h) / vz;
          const errY = posPad[1] + (velPad[1] * h) / vz;
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
        const maxTilt = Math.tan(this.phase === 'terminal' ? TERMINAL_TILT : 8 * DEG);
        if (norm(tilt) > maxTilt) tilt = scale(tilt, maxTilt / norm(tilt));
        const thrustDir = normalize(add(bulk, tilt));
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

  /**
   * Thrust acceleration needed right now to stop at the hover point with constant deceleration,
   * net of gravity and drag, m/s^2 (vertical).
   */
  private stopDemand(aux: Aux, velPad: V3, baseHeight: number, dragCredit = 1): number {
    const h = Math.max(1, baseHeight - this.hoverHeight);
    const vz = -velPad[2];
    const vf = 1;
    const aReq = Math.max(0, vz * vz - vf * vf) / (2 * h);
    const speed = norm(velPad);
    const dragUp = speed > 1 ? (this.dragAccel(aux, speed) * vz) / speed : 0;
    return aReq + 9.8 - dragCredit * dragUp;
  }

  private shouldIgnite(booster: Vehicle, aux: Aux, velPad: V3, baseHeight: number): boolean {
    // Drag does most of the braking on the way down; the burn only starts in the last few km.
    if (velPad[2] > -20 || baseHeight > 6000) return false;
    const perEngine = engineThrust(booster.engines[0].place.type, 1, aux.pAmb);
    const a13 = (13 * perEngine) / aux.mp.mass;
    // Count only part of today's drag: it fades as the booster slows, and the engines must make
    // up the difference (counting all of it lit them so late they ran out of thrust at the end).
    return this.stopDemand(aux, velPad, baseHeight, IGNITE_DRAG_CREDIT) >= LANDING_PLAN * a13;
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

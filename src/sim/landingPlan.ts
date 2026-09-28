// Landing-burn planning for Super Heavy: fast forward simulations of the fall and of the
// landing burn, so the burn lights at the right moment for the booster as it actually is (its
// mass, the air it falls through, how fast it's coming down) rather than by a rule of thumb.
//
// The last part of the return is nearly vertical and only ~15-40 km up, so a flat-Earth point
// mass in the pad's frame is plenty: height, horizontal speed (along a fixed direction), vertical
// speed and mass.

import { REF_AREA, axialCoefficient } from './aero';
import { atmosphere } from './atmosphere';
import { PAD } from './constants';
import { type EngineType, engineMassFlow, engineThrust, throttleForThrust } from './engine';
import { clamp } from './math';

const G = 9.79;

export interface FallState {
  /** Booster base height, pad ENU up, m. */
  z: number;
  /** Horizontal speed (toward the landing point, or away: it only has to be slowed), m/s. */
  vh: number;
  /** Vertical speed (negative down), m/s. */
  vz: number;
  mass: number;
}

export interface BurnResult {
  /** Highest thrust the burn asks of its engines, as a fraction of their full thrust. */
  peak: number;
  /** Propellant used, kg. */
  prop: number;
  /** Highest dynamic pressure during the burn, Pa. */
  qMax: number;
  /** It stops at the hover point (false: it gets there too fast, or not at all). */
  ok: boolean;
  /** Horizontal distance flown during the burn (along the horizontal velocity), m. */
  range: number;
  /** Burn time, s. */
  time: number;
}

/** What the planning needs to know about the booster. */
export interface Lander {
  type: EngineType;
  /** Engines lit for the burn, then the few it finishes on. */
  many: number;
  few: number;
  /** Sideways aerodynamic force per radian of angle of attack, per unit dynamic pressure, m^2. */
  liftPerRad: number;
}

/** Side load (q x sin(angle of attack), Pa) the booster's steering stays under: a quarter of the structural limit. */
export const STEER_Q_ALPHA = 10e3;

/**
 * How far from engines-first (retrograde) the landing burn may point at this dynamic pressure,
 * rad, or null where it's free to (the side load is then no concern).
 */
export function retroCone(q: number): number | null {
  if (q <= 1e3) return null;
  const limit = Math.asin(Math.min(1, STEER_Q_ALPHA / q));
  return limit < 20 * (Math.PI / 180) ? 0.8 * limit : null;
}

/** Engines-first drag deceleration, m/s^2, and dynamic pressure, Pa. */
function drag(z: number, speed: number, mass: number): { a: number; q: number; p: number } {
  const atm = atmosphere(z + PAD.groundAlt);
  if (atm.rho <= 0 || speed < 1) return { a: 0, q: 0, p: atm.p };
  const q = 0.5 * atm.rho * speed * speed;
  return { a: (q * REF_AREA * axialCoefficient(speed / atm.a, true)) / mass, q, p: atm.p };
}

/** Unpowered fall (engines-first, with drag) for `dt` seconds, in small steps. */
export function fall(s: FallState, dt: number, step = 0.05): FallState & { qMax: number } {
  let { z, vh, vz } = s;
  let qMax = 0;
  for (let t = 0; t < dt - 1e-9; t += step) {
    const h = Math.min(step, dt - t);
    const speed = Math.hypot(vh, vz);
    const d = drag(z, speed, s.mass);
    qMax = Math.max(qMax, d.q);
    const k = speed > 1 ? d.a / speed : 0;
    vh -= vh * k * h;
    vz += (-G - vz * k) * h;
    z += vz * h;
  }
  return { z, vh, vz, mass: s.mass, qMax };
}

/**
 * Fly the landing burn from this state, lit now, with the landing guidance boosterReturn.ts uses:
 * brake along the velocity at the constant deceleration that stops it at the hover height
 * (net of gravity and of the drag it's getting), on the full set of landing engines and then, once
 * they're more than it needs, on the few center ones. The engines take a second to spool up
 * (or, for a burn already `running`, carry on from where they are).
 */
export function landingBurn(s: FallState, hoverZ: number, eng: Lander, running?: { throttle: number; few: boolean }): BurnResult {
  let { z, vh, vz, mass } = s;
  let few = running?.few ?? false;
  let thr = running?.throttle ?? 0;
  let peak = 0;
  let prop = 0;
  let qMax = 0;
  let range = 0;
  let t = 0;
  for (let dt = 0.1; t < 240; t += dt) {
    const h = z - hoverZ;
    const speed = Math.hypot(vh, vz);
    // (Finer steps near the end, where the guidance tightens.)
    dt = clamp(h / Math.max(1, speed) / 20, 0.01, 0.1);
    // At the hover point, slow enough for the final approach to take over (it arrives still
    // coming down at up to ~35 m/s, which it stops in well under 30 m), or got there too fast.
    if (speed < 8 || h < 15) return { peak, prop, qMax, ok: speed < 35, range, time: t };
    const d = drag(z, speed, mass);
    qMax = Math.max(qMax, d.q);
    // Commanded acceleration (as in the landing phase): the braking, less the drag already there.
    const hh = Math.max(1, h);
    const vzz = Math.max(1, -vz);
    const aDec = Math.max(0, vz * vz - 16) / (2 * hh);
    const cx = (-vh * aDec) / vzz + (vh * d.a) / Math.max(1, speed);
    const cz = Math.max(0.5, aDec + 9.8 + (vz * d.a) / Math.max(1, speed));
    const c = Math.hypot(cx, cz);
    const force = mass * c;
    // Pointing: along the command, kept near retrograde in thick fast air (as the booster flies it).
    let [ux, uz] = [cx / c, cz / c];
    const cone = retroCone(d.q);
    if (cone !== null && speed > 1) {
      const [rx, rz] = [-vh / speed, -vz / speed];
      const ang = Math.atan2(ux * rz - uz * rx, ux * rx + uz * rz);
      if (Math.abs(ang) > cone) {
        const a = Math.atan2(rz, rx) - Math.sign(ang) * cone;
        [ux, uz] = [Math.cos(a), Math.sin(a)];
      }
    }
    const per = engineThrust(eng.type, 1, d.p);
    if (!few && force < 0.75 * eng.few * per && speed < 120) few = true;
    const n = few ? eng.few : eng.many;
    peak = Math.max(peak, force / (n * per));
    const cmd = clamp(throttleForThrust(eng.type, force / n, d.p), eng.type.minThrottle, 1);
    // Spool: up at 1/s (from zero at ignition), down fast.
    thr = cmd > thr ? Math.min(cmd, thr + dt) : cmd;
    const a = (n * engineThrust(eng.type, thr, d.p)) / mass;
    const k = speed > 1 ? d.a / speed : 0;
    // Body lift: pointed off retrograde, the body and grid fins push the other way.
    let [lx, lz] = [0, 0];
    if (speed > 1) {
      const [rx, rz] = [-vh / speed, -vz / speed];
      const along = ux * rx + uz * rz;
      const f = (-d.q * eng.liftPerRad) / mass;
      [lx, lz] = [(ux - along * rx) * f, (uz - along * rz) * f];
    }
    vh += (ux * a + lx - vh * k) * dt;
    vz += (uz * a + lz - G - vz * k) * dt;
    z += vz * dt;
    range += vh * dt;
    const used = n * engineMassFlow(eng.type, thr) * dt;
    mass -= used;
    prop += used;
  }
  return { peak, prop, qMax, ok: false, range, time: t };
}

export interface IgnitionPlan {
  /** Seconds from now to light the landing burn (0: now). */
  in: number;
  /** Base height at ignition, m (pad ENU up). */
  z: number;
  /** The burn from there. */
  burn: BurnResult;
  /** Highest dynamic pressure before the burn, Pa. */
  qFall: number;
  /** Highest dynamic pressure falling all the way without a burn (how hard the fall is), Pa. */
  qBallistic: number;
  /** Speed at that highest dynamic pressure, m/s. */
  vBallistic: number;
  /** A burn that works within the thrust margin exists (false: best effort). */
  ok: boolean;
}

/**
 * The latest moment to light the landing burn so that it never needs more than `margin` of the
 * engines' thrust: every point of the fall from here is tried as the ignition point (sampled
 * every `sample` s), last first. Latest is best: the air does the braking for free until then
 * (and the burn is shortest).
 */
export function planIgnition(s: FallState, hoverZ: number, eng: Lander, margin: number, sample = 0.25): IgnitionPlan {
  const path: (FallState & { qMax: number })[] = [{ ...s, qMax: 0 }];
  let cur = path[0];
  while (cur.z > hoverZ && path.length < 2400) {
    cur = fall(cur, sample);
    path.push(cur);
  }
  const qUpTo = (i: number) => {
    let q = 0;
    for (let j = 1; j <= i; j++) q = Math.max(q, path[j].qMax);
    return q;
  };
  let qBallistic = 0;
  let vBallistic = 0;
  for (const p of path) {
    if (p.qMax > qBallistic) {
      qBallistic = p.qMax;
      vBallistic = Math.hypot(p.vh, p.vz);
    }
  }
  let best: { i: number; burn: BurnResult } | null = null;
  const score = (b: BurnResult) => b.peak + (b.ok ? 0 : 10);
  const works = (b: BurnResult) => b.ok && b.peak <= margin;
  // Last first, a second at a time, then the last second that works to the sample.
  const stride = Math.max(1, Math.round(1 / sample));
  for (let i = path.length - 1; ; i = Math.max(0, i - stride)) {
    const burn = landingBurn(path[i], hoverZ, eng);
    if (works(burn)) {
      let found = { i, burn };
      for (let k = Math.min(path.length - 1, i + stride - 1); k > i; k--) {
        const b = landingBurn(path[k], hoverZ, eng);
        if (works(b)) {
          found = { i: k, burn: b };
          break;
        }
      }
      return { in: found.i * sample, z: path[found.i].z, burn: found.burn, qFall: qUpTo(found.i), qBallistic, vBallistic, ok: true };
    }
    if (!best || score(burn) < score(best.burn)) best = { i, burn };
    if (i === 0) break;
  }
  // Nothing works with margin: light it where it asks least of the engines.
  const i = best!.i;
  return { in: i * sample, z: path[i].z, burn: best!.burn, qFall: qUpTo(i), qBallistic, vBallistic, ok: false };
}

/**
 * Propellant a landing needs after a normal fall (at terminal speed from high enough for the air
 * to have slowed it), kg: what to keep when venting or burning off the rest.
 */
export function normalLandingProp(mass: number, hoverZ: number, eng: Lander): number {
  const z = hoverZ + 10e3;
  const atm = atmosphere(z + PAD.groundAlt);
  const vt = Math.sqrt((2 * mass * G) / (atm.rho * REF_AREA * axialCoefficient(0.8, true)));
  return planIgnition({ z, vh: 0, vz: -vt, mass }, hoverZ, eng, 0.8).burn.prop;
}

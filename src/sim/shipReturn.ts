// Starship's own way home, on command, from wherever it is: back to a launch tower to be caught
// by the chopsticks (like the booster), or to a point in the ocean. The autopilot plans and flies
// the whole thing:
//
//   plan         what it takes: none (already falling toward the target), or a deorbit burn timed
//                for a pass over the target (searching the next day's orbits), after a
//                circularisation burn at apoapsis (from a suborbital path) or a burn at periapsis
//                lowering a long eccentric orbit. When no pass comes soon, a phasing burn first:
//                a slightly higher orbit's period moves where the ground track crosses the
//                target's latitude, sized per pass to put one right over it; the quickest way
//                home for the fuel wins. Refuses if the propellant or the orbit can't do it.
//   vent         propellant beyond what the burns and the landing need goes overboard (a heavy
//                ship comes in hotter).
//   burns        each flown as a maneuver node on the vacuum engines, warping on rails between.
//   entry        belly-first at 60 deg angle of attack, steering by banking the lift: a
//                predictor-corrector re-plans the landing point every second, choosing how far to
//                bank (less lift up = shorter range) and which way (bank reversals keep the
//                crossrange inside a narrowing deadband), like the Space Shuttle's entry guidance.
//   bellyflop    subsonic: nose toward the target, pitching the belly to glide there.
//   flip, burn   to the target: a splashdown on it, or a hover beside the tower with the whole
//                ship above the arms, then down onto them by its catch pins (one engine: three
//                can't throttle low enough to hover a nearly empty ship).
//
// All positions near the pads are in Pad 1's ENU frame (padFrame.ts).

import { SHIP_CATCH_PIN } from './config/starshipV3';
import { DEG, MU, PAD } from './constants';
import { applyControl } from './control';
import type { Aux } from './dynamics';
import { engineThrust, throttleForThrust } from './engine';
import { airRelativeVelocity, ecefToEci, ecefToEnuMatrix, ecefToGeodetic, eciToEcef, geodeticToEcef, localBasisEci } from './frames';
import { orbitApsides } from './guidance';
import { type V3, add, clamp, cross, dot, mat3Transpose, mat3Vec, norm, normalize, qrot, scale, sub } from './math';
import { MOUNTS, TOWERS, awayFromTower, catchGap } from './padCollision';
import { eciDirToPad, eciToPad, eciVelToPad, padDirToEci, padToEci } from './padFrame';
import { entryAlpha, entryAttitude, heatFlux } from './shipReentry';
import type { Simulation } from './simulation';
import { ARMS, type TowerArms } from './tower';
import { type EntryModel, orbitalFrame, predictTrajectory, propagate } from './trajectory';
import { type Vehicle, setThrottle } from './vehicle';

export type ReturnTarget =
  | { kind: 'tower'; pad: number }
  | { kind: 'ocean'; lat: number; lon: number }
  /** A patch of open ground by the pads (a diverted tower approach sets down there). */
  | { kind: 'ground'; lat: number; lon: number };

export type ReturnPhase =
  | 'burn'
  | 'coast'
  | 'entry'
  | 'bellyflop'
  | 'flip'
  | 'landing'
  | 'terminal'
  | 'caught'
  | 'landed'
  | 'lost';

/** A planned burn: sim time and delta-v along prograde / normal / radial (m/s). */
export interface PlannedBurn {
  label: 'circularize' | 'orbit insertion' | 'lower orbit' | 'phasing' | 'targeting' | 'deorbit';
  t: number;
  dv: V3;
}

export interface ReturnPlan {
  ok: boolean;
  reason?: string;
  burns: PlannedBurn[];
  /** Predicted landing point before guidance, and when (sim time). */
  landing: { lat: number; lon: number; t: number } | null;
  /** Its miss before the entry guidance steers, km. */
  missKm: number;
  dvNeeded: number;
  dvAvailable: number;
}

/** Height of the catch fittings' undersides (what rests on the rails) above the ship's base, m. */
export { SHIP_CATCH_PIN };
/** The ship's entry as flown (for planning and guidance): measured from the sim, approx. */
export const SHIP_ENTRY_MODEL: EntryModel = { dragArea: 339, liftToDrag: (speed) => (speed > 1000 ? 0.53 : speed > 700 ? 0.3 : 0.12) };

/**
 * Planning glides with the lift banked 45 deg (its vertical part: cos 45): the entry guidance can
 * then stretch (less bank) or shorten (more) from there.
 */
const PLAN_MODEL: EntryModel = { dragArea: SHIP_ENTRY_MODEL.dragArea, liftToDrag: (s) => SHIP_ENTRY_MODEL.liftToDrag!(s) * Math.SQRT1_2 };
/** Shortest glide the guidance plans on (lift banked ~70 deg). */
const SHORT_MODEL: EntryModel = { dragArea: SHIP_ENTRY_MODEL.dragArea, liftToDrag: (s) => SHIP_ENTRY_MODEL.liftToDrag!(s) * 0.34 };
/** How far the entry guidance can move the landing point, so how close the plan must get, km. */
const PLAN_ACCEPT_KM = 120;
/** Deorbit burn size to start the search from, m/s (retrograde). */
const DEORBIT_DV = 110;
/**
 * Phasing burn (prograde m/s, + raises the orbit): a slightly different period moves where the
 * ground track crosses the target's latitude, by ~100 km an orbit per 100 m/s. Sized from a trial
 * one of this size.
 */
const PHASING_TRIAL = 30;
/** Orbit insertion (from a path that won't reach a high enough apoapsis): only above this, m, this soon, s. */
const INSERT_MIN_ALT = 140e3;
const INSERT_LEAD = 90;
/** Passes this far off (km) are worth phasing onto. */
const PHASING_REACH_KM = 2500;
/** Largest phasing burn, m/s. */
const PHASING_MAX = 300;
/** How far ahead to look for a pass to phase onto, s. */
const PHASING_WINDOW = 36 * 3600;
/** An orbit this eccentric (apoapsis - periapsis, m) is brought down to one this much above its periapsis first. */
const ECCENTRIC = 600e3;
const ECCENTRIC_TO = 200e3;
/** Perigee that counts as a stable parking orbit, m. */
const PARK_PERIGEE = 150e3;
/** How far ahead to look for a pass, s. */
const SEARCH_WINDOW = 26 * 3600;
/** Belly-flop glide steering: largest nose-down (toward the target) / nose-up tilt from flat, rad. */
const GLIDE_TILT = 18 * DEG;
/** Belly-flop: largest nose-up tilt past flat, to brake, rad. */
const GLIDE_BRAKE = 6 * DEG;
/** Flip and burn starts around here above the target surface (base height), m. */
const FLIP_HEIGHT = 1300;
/** Handed back below this height (m above the target) upright or burning, it goes straight to the landing burn. */
const LANDING_TAKEOVER_HEIGHT = 8000;
/** Tower approach: hover with the ship's base this far above the arms' rails, m. */
const HOVER_CLEAR = 6;
/** The catch pins must be within this of the catch point to close the arms / be caught, m. */
const CAPTURE_RADIUS = 2.5;
/** Most the hovering ship leans beside the arms (more swings its base into them). */
const TERMINAL_NEAR_TILT = 5 * DEG;
/** How far forward the flip carries the ship (m): the belly-flop aims this far short. */
const FLIP_THROW = 230;
/** Tower: only this close to the catch point (m) may it come down beside the tower to the hover. */
const APPROACH_OFF = 12;
/** Catch pins (body +-z) this far round from the line across the arms' gap: the arms close / the pins still land on the rails. */
const PIN_ROLL_CLOSE = 4 * DEG;
const PIN_ROLL_CATCH = 8 * DEG;
/** Largest landing-burn lean from vertical, rad. */
const LANDING_TILT = 25 * DEG;
/** Tower approach: moving sideways anywhere but the staging point, keep the ship's base this high (above the tower's top), m. */
const TRANSIT_BASE = 175;
/** Largest lean in the final hover beside the tower, rad. */
const TERMINAL_TILT = 15 * DEG;
const ALPHA_BELLYFLOP = 88 * DEG;
/** How fast the belly-flopping ship yaws its glide heading round, rad/s. */
const GLIDE_TURN_RATE = 8 * DEG;

/** Great-circle distance between two lat/lon points (deg), km. */
export function greatCircleKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** The target's surface point (lat/lon, deg): the ocean point, or the tower's launch mount. */
export function targetLatLon(target: ReturnTarget): { lat: number; lon: number } {
  if (target.kind !== 'tower') return { lat: target.lat, lon: target.lon };
  // Mount centres are in Pad 1's ENU frame; a few hundred metres apart, flat-Earth is fine.
  const [e, n] = MOUNTS[target.pad] ?? [0, 0];
  return { lat: PAD.latDeg + n / 110_800, lon: PAD.lonDeg + e / (111_320 * Math.cos(PAD.latDeg * DEG)) };
}

/**
 * Propellant kept for the landing beyond the header tanks, kg: the flip and landing burn and the
 * slow final descent onto the arms take more than the headers hold.
 */
const LANDING_MARGIN_PROP = 25e3;
/** Venting rate for propellant it won't need, kg/s. */
const VENT_RATE = 5e3;

/** Delta-v the ship can spend on maneuvers: its main-tank propellant (the landing's is kept). */
export function maneuverDeltaV(ship: Vehicle): number {
  const s = ship.stages[0];
  const header = (s.def.header?.mass ?? s.def.reserve) + LANDING_MARGIN_PROP;
  const dry = s.def.dryMass;
  const vac = ship.engines.find((e) => e.place.ring === 1)?.place.type;
  const isp = vac ? vac.ispVac : 370;
  const m0 = dry + s.prop;
  const m1 = dry + Math.min(s.prop, header);
  return m0 > m1 ? isp * 9.80665 * Math.log(m0 / m1) : 0;
}

/**
 * Plan the way to the target from the ship's state now: which burns, when, how big, and whether
 * the propellant covers them.
 */
export function planReturn(
  ship: Vehicle,
  t: number,
  mass: number,
  target: ReturnTarget,
  /** Consider a phasing burn first (not when re-planning a deorbit burn already lined up). */
  options = true,
  /**
   * Re-planning a deorbit burn already lined up for this time: keep to that pass if it's still
   * within the entry's reach (a little over the planning limit is fine: better than a day more).
   */
  keepPass?: number,
): ReturnPlan {
  const goal = targetLatLon(target);
  const dvAvailable = maneuverDeltaV(ship);
  const land = (r: V3, v: V3, t0: number, burn?: { t: number; dv: V3 }, model = PLAN_MODEL) => {
    const p = predictTrajectory('plan', r, v, t0, model, mass, burn);
    return p.impact ? { lat: p.impact.lat, lon: p.impact.lon, t: t0 + p.impact.dt, ecef: p.impact.ecef } : null;
  };
  const fail = (reason: string, dvNeeded = 0): ReturnPlan => ({ ok: false, reason, burns: [], landing: null, missKm: Infinity, dvNeeded, dvAvailable });

  // Already coming down with the target inside its reach (between the longest glide, lift up,
  // and the shortest, lift banked well over): the entry guidance takes it from here.
  const aps = orbitApsides(ship.r, ship.v);
  if (aps.perigee < 90e3) {
    const far = land(ship.r, ship.v, t, undefined, SHIP_ENTRY_MODEL);
    const near = land(ship.r, ship.v, t, undefined, SHORT_MODEL);
    if (far && near) {
      const g = geodeticToEcef(goal.lat * DEG, goal.lon * DEG, 0);
      const seg = sub(far.ecef, near.ecef);
      const len = norm(seg);
      const along = len > 1 ? dot(sub(g, near.ecef), seg) / (len * len) : 0;
      const across = norm(sub(sub(g, near.ecef), scale(seg, along))) / 1000;
      if (along > -0.05 && along < 1.05 && across < PLAN_ACCEPT_KM) {
        const mid = land(ship.r, ship.v, t);
        return { ok: true, burns: [], landing: mid, missKm: across, dvNeeded: 0, dvAvailable };
      }
    }
  }

  // Otherwise, by way of an orbit, or (coming down) one burn now that aims the fall at the target:
  // whichever gets it home soonest for the fuel.
  const orbit = viaOrbit();
  if (aps.perigee >= 90e3 || !options) return orbit;
  const direct = directBurn(ship, t, mass, goal, dvAvailable, land);
  if (!direct) return orbit;
  const cost = (p: ReturnPlan) => (p.landing!.t - t) / 3600 + p.dvNeeded / 100 + p.missKm / 60;
  if (direct.ok && (!orbit.ok || cost(direct) < cost(orbit))) return direct;
  if (orbit.ok) return orbit;
  return direct.ok ? direct : { ...orbit, reason: `${orbit.reason}; ${direct.reason}` };

  function viaOrbit(): ReturnPlan {
    // Otherwise: a parking orbit first if it isn't in one, then a deorbit burn over a pass. If no
    // pass comes soon, a phasing burn first (a slightly higher or lower orbit: its period shifts
    // where the ground track crosses the target's latitude, orbit by orbit).
    let r = ship.r;
    let v = ship.v;
    let t1 = t;
    // circ: the first burn's horizontal speed change (dv, on top of the horizontal speed there),
    // and the velocity it starts from (so any vertical speed is taken out as well).
    let circ: { t: number; dv: number; label: PlannedBurn['label']; vReal: V3 } | null = null;
    const climbing = dot(ship.v, ship.r) > 0;
    const alt = norm(ship.r) - 6.371e6;
    if (aps.perigee < PARK_PERIGEE) {
      // Climbing to a high enough apoapsis: coast up to it, then prograde to a circular orbit there.
      // Otherwise (already coming down, or topping out low), an orbit insertion burn now, if it's
      // high enough to orbit where it is.
      const atApo = climbing && aps.apogee >= PARK_PERIGEE + 20e3;
      if (!atApo && alt < INSERT_MIN_ALT) {
        return fail(`too low for an orbit (${Math.round(alt / 1000)} km, apoapsis ${Math.round(aps.apogee / 1000)} km) and the target is out of reach from this path`);
      }
      const tApo = atApo ? timeToApoapsis(r, v, t, mass) : t + INSERT_LEAD;
      if (tApo === null) return fail('no apoapsis ahead to circularise at');
      const at = propagate(r, v, t, tApo, { dragArea: 0 }, mass);
      const rn = norm(at.r);
      const vCirc = Math.sqrt(MU / rn);
      const vh = norm(sub(at.v, scale(normalize(at.r), dot(at.v, normalize(at.r)))));
      circ = { t: tApo, dv: vCirc - vh, label: atApo ? 'circularize' : 'orbit insertion', vReal: at.v };
      r = at.r;
      v = scale(normalize(sub(at.v, scale(normalize(at.r), dot(at.v, normalize(at.r))))), vh);
      t1 = tApo;
    } else if (aps.apogee - aps.perigee > ECCENTRIC && options) {
      // A long, eccentric orbit: its landings fall wherever its periapsis is, not where the burn
      // puts them. Lower the apoapsis at periapsis first (retrograde), to a near-circular orbit.
      const tPeri = timeToPeriapsis(r, v, t, mass);
      if (tPeri === null) return fail('no periapsis ahead to lower the orbit at');
      const at = propagate(r, v, t, tPeri, { dragArea: 0 }, mass);
      const rp = norm(at.r);
      const a = rp + ECCENTRIC_TO / 2; // (apoapsis ECCENTRIC_TO above the periapsis)
      const vWant = Math.sqrt(MU * (2 / rp - 1 / a));
      const vh = norm(sub(at.v, scale(normalize(at.r), dot(at.v, normalize(at.r)))));
      circ = { t: tPeri, dv: vWant - vh, label: 'lower orbit', vReal: at.v };
      r = at.r;
      v = scale(normalize(sub(at.v, scale(normalize(at.r), dot(at.v, normalize(at.r))))), vh);
      t1 = tPeri;
    } else {
      // Already in orbit: any phasing burn a couple of minutes from now.
      t1 = options ? t + 120 : t;
      const at = propagate(r, v, t, t1, { dragArea: 0 }, mass);
      r = at.r;
      v = at.v;
    }
    // The first burn as flown (ECI), with a phasing change on top.
    const firstBurn = (phase: number): V3 => (circ ? sub(scale(normalize(v), norm(v) + circ.dv + phase), circ.vReal) : scale(normalize(v), phase));
    const circCost = circ ? norm(firstBurn(0)) : 0;
    if (circ && circCost + DEORBIT_DV > dvAvailable) {
      const dvNeeded = circCost + DEORBIT_DV;
      return fail(`needs ${Math.round(dvNeeded)} m/s (${circ.label} ${Math.round(circCost)} + deorbit) but only ${Math.round(dvAvailable)} m/s is left above the landing reserve`, dvNeeded);
    }
    // (Re-planning a deorbit burn that's close: it may be only a minute or two away.)
    const earliest = options || circ ? t1 + 300 : t + 60;

    // Options: straight to the first pass the deorbit burn reaches; or a phasing burn at t1 (on
    // top of any circularisation) sized to put a later pass right over the target. The quickest
    // home wins, counting each 100 m/s spent as an hour.
    const pro = orbitalFrame(r, v).pro;
    const orbitWith = (phase: number): V3 | null => {
      const vAfter = add(v, scale(pro, phase + (circ?.dv ?? 0)));
      if ((circ || phase) && orbitApsides(r, vAfter).perigee < PARK_PERIGEE - 10e3) return null;
      return vAfter;
    };
    type Option = PassResult & { phase: number; cost: number };
    let best: Option | null = null;
    let closest: PassResult | null = null;
    const consider = (res: PassResult | null, phase: number) => {
      if (!res) return;
      if (!closest || res.miss < closest.miss) closest = res;
      const dv = norm(firstBurn(phase)) + res.dv;
      if (res.miss > PLAN_ACCEPT_KM * (keepPass !== undefined ? 1.5 : 1) || dv > dvAvailable) return;
      // (Time home, plus fuel, plus how much the entry will have to steer: a near miss is safer.)
      const cost = (res.landing.t - t) / 3600 + dv / 100 + res.miss / 60;
      if (!best || cost < best.cost) best = { ...res, phase, cost };
    };
    const v0 = orbitWith(0)!;
    const track0 = groundPasses(r, v0, t1, t1 + SEARCH_WINDOW, mass, goal);
    consider(firstPass(track0, mass, goal, earliest, land, keepPass), 0);
    if (options) {
      // How each pass's offset from the target moves with the phasing burn (a trial one), then,
      // pass by pass, the burn that zeroes it (a secant step or two).
      const trial = orbitWith(PHASING_TRIAL);
      const track1 = trial ? groundPasses(r, trial, t1, t1 + PHASING_WINDOW + 3600, mass, goal, PHASING_REACH_KM) : null;
      const wide = track1 ? groundPasses(r, v0, t1, t1 + PHASING_WINDOW, mass, goal, PHASING_REACH_KM) : null;
      for (const p0 of wide ? wide.passes : []) {
        if (p0.t < earliest + 600) continue;
        const sofar = best as Option | null;
        if (sofar && p0.t > sofar.landing.t) break;
        let [xa, ya] = [0, p0.offset];
        const p1 = matchPass(track1!, p0.t, 1800);
        if (!p1) continue;
        let [xb, yb] = [PHASING_TRIAL, p1.offset];
        // (The pass comes a little later on a higher orbit: where to look for it.)
        const tPer = (p1.t - p0.t) / PHASING_TRIAL;
        let found: { phase: number; track: Track; pass: Pass } | null = null;
        for (let k = 0; k < 3; k++) {
          if (Math.abs(yb - ya) < 1e-3) break;
          const x = xb - (yb * (xb - xa)) / (yb - ya);
          if (!Number.isFinite(x) || Math.abs(x) > PHASING_MAX) break;
          const vx = orbitWith(x);
          if (!vx || norm(firstBurn(x)) + 50 > dvAvailable) break;
          const tAt = p0.t + tPer * x;
          const tr = groundPasses(r, vx, t1, tAt + 3600, mass, goal, PHASING_REACH_KM);
          const px = matchPass(tr, tAt, 1200);
          if (!px) break;
          found = { phase: x, track: tr, pass: px };
          if (Math.abs(px.offset) < PLAN_ACCEPT_KM / 3) break;
          [xa, ya, xb, yb] = [xb, yb, x, px.offset];
        }
        if (found) consider(refinePass(found.track, found.pass, mass, goal, earliest, land), found.phase);
      }
    }
    if (!best) {
      const c = closest as PassResult | null;
      if (c && c.miss <= PLAN_ACCEPT_KM) {
        const dvNeeded = circCost + c.dv;
        return fail(`needs ${Math.round(dvNeeded)} m/s but only ${Math.round(dvAvailable)} m/s is left above the landing reserve`, dvNeeded);
      }
      return fail(c ? `no pass in the next day comes within reach (best misses by ${Math.round(c.miss)} km)` : 'no pass over the target in the next day');
    }
    const b = best as Option;
    const burns: PlannedBurn[] = [];
    if (circ || b.phase) {
      // (In the frame of the velocity it starts from: prograde, normal, radial.)
      const f = orbitalFrame(r, circ ? circ.vReal : v);
      const d = firstBurn(b.phase);
      burns.push({ label: circ ? circ.label : 'phasing', t: t1, dv: [dot(d, f.pro), dot(d, f.nrm), dot(d, f.rad)] });
    }
    burns.push({ label: 'deorbit', t: b.t, dv: [-b.dv, 0, 0] });
    const dvNeeded = burns.reduce((a, x) => a + norm(x.dv), 0);
    return { ok: true, burns, landing: b.landing, missKm: b.miss, dvNeeded, dvAvailable };
  }
}

/** Most the aim of a direct burn may be off and still count, km (the entry steers out the rest). */
const DIRECT_ACCEPT_KM = 30;
/** A direct burn lights this long after the command (time to turn to it), s. */
const DIRECT_LEAD = 60;

/**
 * Coming down (not in orbit): the single burn, a minute from now, that puts the fall onto the
 * target. Newton steps on the landing point (east / north of the target) against the burn
 * (prograde, normal, radial), each the smallest change that zeroes the miss; null if the
 * current path doesn't come down at all.
 */
function directBurn(
  ship: Vehicle,
  t: number,
  mass: number,
  goal: { lat: number; lon: number },
  dvAvailable: number,
  land: (r: V3, v: V3, t0: number, burn?: { t: number; dv: V3 }) => { lat: number; lon: number; t: number; ecef: V3 } | null,
): ReturnPlan | null {
  const tb = t + DIRECT_LEAD;
  const at = propagate(ship.r, ship.v, t, tb, { dragArea: 0 }, mass);
  const f = orbitalFrame(at.r, at.v);
  const g = geodeticToEcef(goal.lat * DEG, goal.lon * DEG, 0);
  const R = ecefToEnuMatrix(goal.lat * DEG, goal.lon * DEG);
  const toEci = (d: V3): V3 => add(add(scale(f.pro, d[0]), scale(f.nrm, d[1])), scale(f.rad, d[2]));
  const missOf = (d: V3) => {
    const l = land(at.r, at.v, tb, { t: tb, dv: toEci(d) });
    if (!l) return null;
    const e = mat3Vec(R, sub(l.ecef, g));
    return { e: [e[0], e[1]] as [number, number], l };
  };
  let dv: V3 = [0, 0, 0];
  let cur = missOf(dv);
  if (!cur) return null;
  for (let it = 0; it < 8 && Math.hypot(...cur.e) > 2e3; it++) {
    // Sensitivities (m of landing point per m/s), by finite differences.
    const J: number[][] = [[], []];
    for (let k = 0; k < 3; k++) {
      const d: V3 = [...dv];
      d[k] += 5;
      const m = missOf(d);
      if (!m) return null;
      J[0][k] = (m.e[0] - cur.e[0]) / 5;
      J[1][k] = (m.e[1] - cur.e[1]) / 5;
    }
    // Smallest step that zeroes the miss (least norm), at most 150 m/s at a time.
    const a = J[0][0] ** 2 + J[0][1] ** 2 + J[0][2] ** 2;
    const b = J[0][0] * J[1][0] + J[0][1] * J[1][1] + J[0][2] * J[1][2];
    const c = J[1][0] ** 2 + J[1][1] ** 2 + J[1][2] ** 2;
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-9) break;
    const [mx, my] = [-cur.e[0], -cur.e[1]];
    const y0 = (c * mx - b * my) / det;
    const y1 = (-b * mx + a * my) / det;
    let step: V3 = [0, 1, 2].map((k) => J[0][k] * y0 + J[1][k] * y1) as V3;
    if (norm(step) > 150) step = scale(step, 150 / norm(step));
    // Halve the step until it helps (the landing point isn't linear in the burn far off).
    let next = null;
    for (let h = 0; h < 5; h++) {
      const cand = add(dv, step);
      const m = missOf(cand);
      if (m && Math.hypot(...m.e) < Math.hypot(...cur.e)) {
        next = { dv: cand, m };
        break;
      }
      step = scale(step, 0.5);
    }
    if (!next) break;
    dv = next.dv;
    cur = next.m;
    if (norm(dv) > dvAvailable * 1.5) break;
  }
  const missKm = Math.hypot(...cur.e) / 1000;
  const dvNeeded = norm(dv);
  const plan: ReturnPlan = { ok: true, burns: [{ label: 'targeting', t: tb, dv }], landing: cur.l, missKm, dvNeeded, dvAvailable };
  if (missKm > DIRECT_ACCEPT_KM) return { ...plan, ok: false, reason: `no single burn from this path reaches it (best misses by ${Math.round(missKm)} km)` };
  if (dvNeeded > dvAvailable) return { ...plan, ok: false, reason: `a burn onto it needs ${Math.round(dvNeeded)} m/s but only ${Math.round(dvAvailable)} m/s is left above the landing reserve` };
  return plan;
}

interface PassResult {
  /** Deorbit burn time (sim time) and size (retrograde, m/s). */
  t: number;
  dv: number;
  miss: number;
  landing: { lat: number; lon: number; t: number };
}

type LandFn = (r: V3, v: V3, t0: number, burn?: { t: number; dv: V3 }) => { lat: number; lon: number; t: number } | null;

interface Pass {
  /** Index into the track's states, and time. */
  i: number;
  t: number;
  /** The target's distance from the ground track there, km: + to the left of the track. */
  offset: number;
}

interface Track {
  t1: number;
  states: { t: number; r: V3; v: V3; lat: number; lon: number }[];
  passes: Pass[];
}

const TRACK_STEP = 30;

/** Orbit states from t1 to `until`, and the passes over the target (closest approaches of the ground track). */
function groundPasses(r: V3, v: V3, t1: number, until: number, mass: number, goal: { lat: number; lon: number }, reachKm = 900): Track {
  const states: Track['states'] = [];
  let sr = r;
  let sv = v;
  for (let tt = t1; tt < until; tt += TRACK_STEP) {
    const g = ecefToGeodetic(eciToEcef(sr, tt));
    states.push({ t: tt, r: sr, v: sv, lat: g.lat / DEG, lon: g.lon / DEG });
    const nx = propagate(sr, sv, tt, tt + TRACK_STEP, { dragArea: 0 }, mass, 30);
    sr = nx.r;
    sv = nx.v;
  }
  const km = states.map((s) => greatCircleKm(s, goal));
  const gE = geodeticToEcef(goal.lat * DEG, goal.lon * DEG, 0);
  const passes: Pass[] = [];
  for (let i = 1; i < states.length - 1; i++) {
    if (!(km[i] <= km[i - 1] && km[i] < km[i + 1] && km[i] < reachKm)) continue;
    // Which side: the target against the track's direction there (Earth-fixed).
    const a = eciToEcef(states[i - 1].r, states[i - 1].t);
    const b = eciToEcef(states[i + 1].r, states[i + 1].t);
    const p = eciToEcef(states[i].r, states[i].t);
    const left = cross(normalize(p), normalize(sub(b, a)));
    passes.push({ i, t: states[i].t, offset: km[i] * Math.sign(dot(sub(gE, p), left) || 1) });
  }
  return { t1, states, passes };
}

/** The pass in `track` nearest in time to t (the same pass on a slightly different orbit). */
function matchPass(track: Track, t: number, within: number): Pass | null {
  let best: Pass | null = null;
  for (const p of track.passes) if (Math.abs(p.t - t) < within && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
  return best;
}

/** The first pass that a retrograde deorbit burn brings within the entry's reach, or the closest there is. */
function firstPass(track: Track, mass: number, goal: { lat: number; lon: number }, earliest: number, land: LandFn, keepPass?: number): PassResult | null {
  let best: PassResult | null = null;
  // (Keeping to a pass: the one whose deorbit burn falls nearest that time first.)
  const passes = keepPass === undefined ? track.passes : [...track.passes].sort((a, b) => Math.abs(a.t - 1800 - keepPass) - Math.abs(b.t - 1800 - keepPass));
  if (keepPass !== undefined) {
    const kept = passes[0] ? refinePass(track, passes[0], mass, goal, earliest, land) : null;
    if (kept && kept.miss < PLAN_ACCEPT_KM * 1.5) return kept;
  }
  for (const p of track.passes) {
    const cur = refinePass(track, p, mass, goal, earliest, land);
    if (!cur) continue;
    if (!best || cur.miss < best.miss) best = cur;
    if (cur.miss < PLAN_ACCEPT_KM) break;
  }
  return best;
}

/** The deorbit burn (time and size) that brings the ship down closest to the target on this pass. */
function refinePass(track: Track, pass: Pass, mass: number, goal: { lat: number; lon: number }, earliest: number, land: LandFn): PassResult | null {
  const { states, t1 } = track;
  if (pass.t - earliest < 600) return null;
  const retro = (s: { r: V3; v: V3 }, dv: number) => scale(orbitalFrame(s.r, s.v).pro, -dv);
  const stateAt = (tt: number) => {
    const i = Math.max(0, Math.min(states.length - 1, Math.floor((tt - t1) / TRACK_STEP)));
    const s = states[i];
    return tt > s.t ? { ...propagate(s.r, s.v, s.t, tt, { dragArea: 0 }, mass, 30), t: tt } : { r: s.r, v: s.v, t: s.t };
  };
  const evalAt = (tt: number, d: number) => {
    const s = stateAt(tt);
    const l = land(s.r, s.v, s.t, { t: s.t, dv: retro(s, d) });
    return l ? { miss: greatCircleKm(l, goal), l } : null;
  };
  // A burn that brings it down around the pass: the smallest of a few sizes that brings it down
  // at all there, its timing slid until the landing falls at the pass (on an eccentric orbit,
  // how long the fall takes depends on where the burn is).
  let tb = 0;
  let dv = 0;
  let cur: ReturnType<typeof evalAt> = null;
  for (const d of [DEORBIT_DV, 180, 260]) {
    let tt = Math.max(earliest, pass.t - 1800);
    let e = evalAt(tt, d);
    for (let k = 0; k < 4 && e; k++) {
      const shift = pass.t - e.l.t;
      if (Math.abs(shift) < 20) break;
      tt = Math.max(earliest, tt + shift);
      e = evalAt(tt, d);
    }
    if (e) {
      [tb, dv, cur] = [tt, d, e];
      break;
    }
  }
  if (!cur) return null;
  // Refine: burn time (along track) then size, three times, by shrinking scans.
  for (const [span, n] of [[300, 12], [60, 12], [12, 12]] as const) {
    for (let k = -n; k <= n; k++) {
      const tt = tb + (span * k) / n;
      if (tt < earliest) continue;
      const e = evalAt(tt, dv);
      if (e && e.miss < cur.miss) {
        cur = e;
        tb = tt;
      }
    }
    for (const dd of [-30, -15, -7, -3, 3, 7, 15, 30].map((x) => (x * span) / 300)) {
      const d2 = clamp(dv + dd, 50, 300);
      const e = evalAt(tb, d2);
      if (e && e.miss < cur.miss) {
        cur = e;
        dv = d2;
      }
    }
  }
  return { t: tb, dv, miss: cur.miss, landing: cur.l };
}

/** Next apoapsis time (sim time), by coasting along the orbit; null if it's falling in first. */
function timeToApoapsis(r: V3, v: V3, t: number, mass: number): number | null {
  let rr = r;
  let vv = v;
  let tt = t;
  for (let i = 0; i < 400; i++) {
    const radial = dot(vv, rr) / norm(rr);
    if (radial <= 0 && i > 0) return tt;
    if (norm(rr) < 6.371e6 + 120e3 && radial < 0) return null;
    const nx = propagate(rr, vv, tt, tt + 15, { dragArea: 0 }, mass, 15);
    const radial2 = dot(nx.v, nx.r) / norm(nx.r);
    if (radial > 0 && radial2 <= 0) {
      // Interpolate the zero crossing.
      return tt + (15 * radial) / (radial - radial2);
    }
    rr = nx.r;
    vv = nx.v;
    tt += 15;
  }
  return null;
}

/** Next periapsis time (sim time): where the radial speed turns from falling to climbing. */
function timeToPeriapsis(r: V3, v: V3, t: number, mass: number): number | null {
  let rr = r;
  let vv = v;
  let tt = t;
  for (let i = 0; i < 2000; i++) {
    const radial = dot(vv, rr) / norm(rr);
    const nx = propagate(rr, vv, tt, tt + 15, { dragArea: 0 }, mass, 15);
    const radial2 = dot(nx.v, nx.r) / norm(nx.r);
    if (radial < 0 && radial2 >= 0) return tt + (15 * -radial) / (radial2 - radial);
    rr = nx.r;
    vv = nx.v;
    tt += 15;
  }
  return null;
}

/** Guides the ship home. */
export class ShipReturn {
  phase: ReturnPhase = 'coast';
  plan: ReturnPlan;
  /** What the guidance is doing now, for the HUD. */
  status = '';
  /** Predicted landing point (latest guidance prediction) and its miss, km. */
  predicted: { lat: number; lon: number; missKm: number } | null = null;
  private burnIndex = 0;
  private touchedUp = false;
  private burning = false;
  private bank = 0;
  private bankSign = 1;
  private nextGuide = 0;
  private heading: V3 | null = null;
  private oneEngine = false;
  /** Sea-level engines lit in the landing burn / hover. */
  private lit = 3;
  /** Belly-flop glide heading (ECI, horizontal), turned gradually. */
  private glideHeading: V3 | null = null;
  /** Integral of the hover's position error, m s. */
  private intOff = [0, 0];
  private closing = false;
  private lastPin: V3 | null = null;
  private pinVel: V3 = [0, 0, 0];
  /** How far the catch pins are rolled off the line across the arms' gap, rad. */
  private rollErr = 0;
  /** The flight's milestones already logged (entry interface, peak heating, ...), and the peak heat flux so far. */
  private milestones = new Set<string>();
  private peakHeat = 0;
  private venting = false;
  private vented = 0;

  private milestone(key: string, text: string): void {
    if (this.milestones.has(key)) return;
    this.milestones.add(key);
    this.log(text);
  }

  constructor(
    private sim: Simulation,
    private ship: Vehicle,
    public target: ReturnTarget,
    private log: (text: string) => void,
    /** Consider phasing burns (off for a quick check of whether no burn is needed at all). */
    phasing = true,
  ) {
    const mass = sim.aux.get(ship.id)?.mp.mass ?? 2e5;
    this.plan = planReturn(ship, sim.t, mass, target, phasing);
    if (!this.plan.ok) {
      this.phase = 'lost';
      this.status = `Can't return: ${this.plan.reason}`;
      log(this.status);
      return;
    }
    const where = target.kind === 'tower' ? `Pad ${target.pad + 1} tower` : 'the ocean target';
    const burns = this.plan.burns.map((b) => `${b.label} ${norm(b.dv).toFixed(0)} m/s`).join(', ');
    log(`Return to ${where} planned: ${burns || 'no burn needed'} (${Math.round(this.plan.dvNeeded)} of ${Math.round(this.plan.dvAvailable)} m/s)`);
    this.phase = this.plan.burns.length ? 'burn' : 'coast';
    this.setNode();
  }

  private get arms(): TowerArms | null {
    return this.target.kind === 'tower' ? this.sim.towers[this.target.pad] : null;
  }

  /**
   * The frame the end of the flight is flown in: Pad 1's ENU frame for a tower (the arms and
   * collision model live there), ENU at the target point for an ocean landing. Returns the
   * target point in it and converters.
   */
  private frame(): { target: V3; pos: (r: V3) => V3; vel: (r: V3, v: V3) => V3; dir: (d: V3) => V3; dirIn: (d: V3) => V3 } {
    const t = this.sim.t;
    if (this.target.kind === 'tower') {
      const [e, n] = MOUNTS[this.target.pad];
      return { target: [e, n, 0], pos: (r) => eciToPad(r, t), vel: (r, v) => eciVelToPad(r, v, t), dir: (d) => padDirToEci(d, t), dirIn: (d) => eciDirToPad(d, t) };
    }
    const lat = this.target.lat * DEG;
    const lon = this.target.lon * DEG;
    const origin = geodeticToEcef(lat, lon, 0);
    const R = ecefToEnuMatrix(lat, lon);
    const Rt = mat3Transpose(R);
    return {
      target: [0, 0, 0],
      pos: (r) => mat3Vec(R, sub(eciToEcef(r, t), origin)),
      vel: (r, v) => mat3Vec(R, eciToEcef(airRelativeVelocity(r, v), t)),
      dir: (d) => ecefToEci(mat3Vec(Rt, d), t),
      dirIn: (d) => mat3Vec(R, eciToEcef(d, t)),
    };
  }

  /** Re-plan the remaining burns from the state now (keeping the target). */
  private replan(ship: Vehicle, aux: Aux): void {
    const b = this.plan.burns[this.burnIndex];
    const p = planReturn(ship, this.sim.t, aux.mp.mass, this.target, false, b?.label === 'deorbit' ? b.t : undefined);
    if (!p.ok || !p.burns.length) {
      if (!p.ok) this.log(`Return: re-plan failed (${p.reason}), keeping the old plan`);
      return;
    }
    const done = this.plan.burns.slice(0, this.burnIndex);
    this.plan = { ...p, burns: [...done, ...p.burns.filter((b) => b.label === 'deorbit')] };
    const d = this.plan.burns[this.burnIndex];
    if (d) this.log(`Return: re-planned deorbit ${Math.abs(d.dv[0]).toFixed(0)} m/s, predicted miss ${p.missKm.toFixed(0)} km`);
  }

  private setNode(): void {
    const b = this.plan.burns[this.burnIndex];
    this.sim.setNode(b ? { vehicle: this.ship.id, t: b.t, dv: b.dv } : null);
    this.burning = false;
  }

  /**
   * The player flew the ship for a while and hands it back: pick up from the state it's in now.
   * Low down, upright or already burning, that's the landing burn (whatever phase it was in);
   * before the deorbit burn, re-plan the burns for the orbit it's on now.
   */
  resume(ship: Vehicle, aux: Aux): void {
    this.lastPin = null;
    this.pinVel = [0, 0, 0];
    this.intOff = [0, 0];
    const lit = ship.engines.filter((e) => e.place.ring === 0 && e.throttle > 0.05).length;
    this.lit = lit || 3;
    const t = this.sim.t;
    const { u: up } = localBasisEci(aux.geo, t);
    const upright = dot(normalize(qx(ship)), up) > Math.cos(45 * DEG);
    const hAbove = aux.geo.h - this.surfaceHeight();
    const descending = ['entry', 'bellyflop', 'flip', 'landing', 'terminal'].includes(this.phase);
    // (Only down low: in the entry the ship flies nose-high, belly-first at 60 deg to the flow,
    // which from its attitude alone looks "upright"; handed back up there, it carries on with
    // the entry rather than lighting up for a landing burn 100 km too early.)
    const low = hAbove < LANDING_TAKEOVER_HEIGHT;
    if (descending && this.phase !== 'terminal' && low && (upright || lit > 0 || hAbove < FLIP_HEIGHT)) {
      this.phase = upright ? 'landing' : 'flip';
      setThrottle(ship, 'ship', 1, (ring) => ring === 0);
    } else if (this.phase === 'burn') {
      this.replan(ship, aux);
    }
    this.log(`Return: autopilot back in control (${this.phase})`);
  }

  cancel(): void {
    if (this.phase === 'burn') this.sim.setNode(null);
    setThrottle(this.ship, 'ship', 0);
    this.sim.waitUntil = null;
  }

  update(ship: Vehicle, aux: Aux, dt: number): void {
    const t = this.sim.t;
    const { u: up } = localBasisEci(aux.geo, t);
    const vAir = airRelativeVelocity(ship.r, ship.v);
    const speed = norm(vAir);
    const vHat = speed > 1 ? scale(vAir, 1 / speed) : scale(up, -1);
    const vz = dot(vAir, up);
    const vh = sub(vAir, scale(up, vz));
    if (norm(vh) > 20) this.heading = normalize(vh);
    const heading = this.heading ?? normalize(cross(up, [0, 0, 1]));
    const axis = normalize(qx(ship));
    const xBase = ship.stages[0].def.xBase;
    const baseHeight = aux.geo.h - (aux.mp.xcg - xBase) * dot(axis, up);

    // The flight's milestones, as the plain entry profile logs them.
    if (aux.geo.h < 100e3 && vz < 0) this.milestone('entry', 'Entry interface (100 km)');
    const heat = heatFlux(aux.rho, speed);
    if (heat > this.peakHeat) this.peakHeat = heat;
    else if (this.peakHeat > 1e5 && heat < 0.9 * this.peakHeat) {
      this.milestone('peakHeat', `Peak heating ~${(this.peakHeat / 1e4).toFixed(0)} W/cm² at ${(aux.geo.h / 1000).toFixed(0)} km`);
    }
    if (this.phase === 'entry' && aux.q > 1e3) this.milestone('flaps', 'Flaps active');

    switch (this.phase) {
      case 'burn': {
        // Propellant beyond what the burns and the landing need goes overboard first: a heavy
        // ship comes in hotter (and the plan is re-made for the lighter ship after the burn).
        if (this.burnIndex === 0 && !this.burning && this.ventExcess(ship, dt)) {
          this.sim.waitUntil = null;
          applyControl(ship, aux, axis, dt);
          break;
        }
        // Fly the planned maneuver nodes on the vacuum engines.
        const node = this.sim.node;
        const snap = this.sim.nodeSnapshot();
        if (!node || !snap) {
          // This burn is done.
          setThrottle(ship, 'ship', 0);
          this.burnIndex++;
          if (this.burnIndex < this.plan.burns.length) {
            // Re-plan what's left from the orbit it actually reached (small differences grow over
            // the hours to the pass).
            this.replan(ship, aux);
            this.setNode();
          } else {
            this.phase = 'coast';
            this.sim.waitUntil = null;
            this.log('Return: burns complete, coasting to entry');
          }
          break;
        }
        const dir = this.sim.pilot.maneuverDir ?? axis;
        applyControl(ship, aux, dir, dt);
        const start = node.node.t - snap.burnTime / 2;
        const aligned = dot(axis, dir) > Math.cos(3 * DEG);
        if (!this.burning && t >= start && aligned) {
          this.burning = true;
          this.sim.waitUntil = null;
        }
        if (this.burning) {
          // Taper near the end so the cutoff lands on the plan.
          const thr = snap.remaining < 5 ? 0.4 : 1;
          setThrottle(ship, 'ship', thr, (ring) => ring === 1);
          this.status = `${this.plan.burns[this.burnIndex].label} burn: ${snap.remaining.toFixed(1)} m/s to go`;
        } else {
          setThrottle(ship, 'ship', 0);
          // One last touch-up of the deorbit burn about ten minutes out.
          const b = this.plan.burns[this.burnIndex];
          if (b.label === 'deorbit' && !this.touchedUp && start - t < 600) {
            this.touchedUp = true;
            this.replan(ship, aux);
            this.setNode();
            break;
          }
          if (start - t > 120) this.sim.waitUntil = start - (this.touchedUp || b.label !== 'deorbit' ? 60 : 660);
          this.status = `${this.plan.burns[this.burnIndex].label} burn in ${fmt(start - t)}`;
        }
        break;
      }

      case 'coast': {
        // Swing to the entry attitude and wait (on rails if far).
        setThrottle(ship, 'ship', 0);
        const att = entryAttitude(vHat, up, heading, entryAlpha(aux.mach));
        applyControl(ship, aux, att.nose, dt, undefined, att.bodyZ);
        this.sim.waitUntil = aux.geo.h > 160e3 ? t + 3600 : null;
        this.status = `coasting to entry (${(aux.geo.h / 1000).toFixed(0)} km)`;
        if (aux.geo.h < 120e3 && vz < 0) {
          this.phase = 'entry';
          this.sim.waitUntil = null;
          this.log('Return: entry guidance active');
        }
        break;
      }

      case 'entry': {
        // Predictor-corrector bank steering.
        if (t >= this.nextGuide) {
          this.nextGuide = t + 1;
          this.guideEntry(ship, aux);
        }
        const att = entryAttitude(vHat, up, heading, entryAlpha(aux.mach), this.bank * this.bankSign);
        applyControl(ship, aux, att.nose, dt, undefined, att.bodyZ);
        if (aux.mach < 1 && aux.geo.h < 30e3) {
          this.phase = 'bellyflop';
          this.milestone('subsonic', `Subsonic: belly-flop at ${(speed * 3.6).toFixed(0)} km/h`);
          this.log(`Return: belly-flop, ${this.distanceToTargetKm(aux).toFixed(1)} km to go`);
          // The tower swings its ship QD arm back out of the way for the catch.
          const arms = this.arms;
          if (arms && !arms.qdStowed) {
            arms.stowQd(true);
            this.log(`Pad ${(this.target as { pad: number }).pad + 1} ship QD arm swinging clear`);
          }
          // And brings its arms round to face the launch mount (they may have been swung aside).
          arms?.command({ slew: 0 });
        }
        break;
      }

      case 'bellyflop': {
        // Nose toward the target; pitch the flat-falling body to glide there.
        const fr = this.frame();
        const tgt = fr.target;
        const pos = fr.pos(ship.r);
        const vel = fr.vel(ship.r, ship.v);
        // Aim short: the flip's thrust (along the nose as it swings up) carries it forward.
        const hd0 = fr.dirIn(this.glideHeading ?? heading);
        const hn = Math.hypot(hd0[0], hd0[1]) || 1;
        const toT: V3 = [tgt[0] - (hd0[0] / hn) * FLIP_THROW - pos[0], tgt[1] - (hd0[1] / hn) * FLIP_THROW - pos[1], 0];
        const dist = Math.hypot(toT[0], toT[1]);
        const hAbove = baseHeight - this.surfaceHeight();
        const tGo = Math.max(5, (hAbove - FLIP_HEIGHT) / Math.max(20, -vel[2]));
        // Horizontal acceleration (both axes) to arrive over the target by the flip, stopped:
        // the nose points along it and tilts down by as much as it needs (never gliding
        // backwards: past flat the falling body goes unstable). x1.6: the glide answers slowly.
        const aH: V3 = [0, 0, 0];
        for (const i of [0, 1] as const) aH[i] = (1.6 * (6 * toT[i] - 4 * vel[i] * tGo)) / (tGo * tGo);
        // Heading: toward the target (turned gradually: a belly-flopping ship yaws slowly).
        // Nose along the acceleration it needs (to arrive over the aim point, stopped, by the
        // flip), not straight at the aim point: a belly-flopping ship pushes itself along its nose, so pointing at
        // the target never takes out a sideways drift. Kept within 60 deg of the target's direction.
        let wantDir = this.glideHeading ?? heading;
        if (dist > 20) {
          const gx = aH[0];
          const gy = aH[1];
          const aT = Math.atan2(toT[1], toT[0]);
          const aG = Math.hypot(gx, gy) > 1 ? Math.atan2(gy, gx) : aT;
          let d = aG - aT;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          const a = aT + clamp(d, -60 * DEG, 60 * DEG);
          wantDir = normalize(fr.dir([Math.cos(a), Math.sin(a), 0]));
        }
        this.glideHeading = turnToward(this.glideHeading ?? heading, wantDir, up, GLIDE_TURN_RATE * dt);
        // Along the heading: nose down to speed toward it, flat (or a touch nose up) to let drag
        // brake it; it can't turn round to brake. Level out approaching the flip.
        const hd = fr.dirIn(this.glideHeading);
        const aAlong = aH[0] * hd[0] + aH[1] * hd[1];
        const level = clamp((hAbove - FLIP_HEIGHT) / 250, 0, 1);
        const tilt = level * clamp(Math.atan2(aAlong, 9.8), -GLIDE_BRAKE, GLIDE_TILT);
        const att = glideAttitude(vHat, this.glideHeading, Math.PI / 2 - ALPHA_BELLYFLOP + tilt);
        applyControl(ship, aux, att.nose, dt, undefined, att.bodyZ);
        this.status = `belly-flop: ${(dist / 1000).toFixed(2)} km to target, ${(hAbove / 1000).toFixed(1)} km up`;
        if (this.shouldFlip(ship, aux, hAbove, -vel[2], Math.hypot(vel[0], vel[1], vel[2]))) {
          setThrottle(ship, 'ship', 1, (ring) => ring === 0);
          this.phase = 'flip';
          this.milestone('flip', `Landing flip and burn (${(hAbove / 1000).toFixed(2)} km, ${(speed * 3.6).toFixed(0)} km/h)`);
          this.log(`Return: flip and landing burn (${(hAbove / 1000).toFixed(2)} km up, ${(dist / 1000).toFixed(2)} km out)`);
        }
        break;
      }

      case 'flip':
      case 'landing':
      case 'terminal':
        this.landingBurn(ship, aux, dt, axis, up, baseHeight);
        break;

      default:
        setThrottle(ship, 'ship', 0);
        applyControl(ship, aux, null, dt);
        break;
    }
  }

  /**
   * Vent main-tank propellant beyond what the planned burns (with margin) and the landing need,
   * a step at a time; true while venting.
   */
  private ventExcess(ship: Vehicle, dt: number): boolean {
    const s = ship.stages[0];
    const vac = ship.engines.find((e) => e.place.ring === 1)?.place.type;
    const isp = (vac ? vac.ispVac : 370) * 9.80665;
    const dvLeft = this.plan.burns.slice(this.burnIndex).reduce((a, b) => a + norm(b.dv), 0);
    const reserve = (s.def.header?.mass ?? s.def.reserve) + LANDING_MARGIN_PROP;
    const mEnd = s.def.dryMass + reserve;
    const keep = reserve + mEnd * (Math.exp((1.15 * dvLeft + 30) / isp) - 1);
    const excess = s.prop - keep;
    if (excess <= 0 || (!this.venting && excess < 5e3)) {
      if (this.venting) {
        this.venting = false;
        this.log(`Return: venting complete (${(this.vented / 1000).toFixed(0)} t overboard)`);
      }
      return false;
    }
    if (!this.venting) {
      this.venting = true;
      this.log(`Return: venting ${(excess / 1000).toFixed(0)} t of propellant it won't need (a lighter ship comes in cooler)`);
    }
    const d = Math.min(excess, VENT_RATE * dt);
    s.prop -= d;
    this.vented += d;
    return true;
  }

  /** Height (above the ellipsoid) of the surface it's coming down on: the pad's ground, or the sea. */
  private surfaceHeight(): number {
    return this.target.kind === 'ocean' ? 0 : PAD.groundAlt;
  }

  private distanceToTargetKm(aux: Aux): number {
    return greatCircleKm({ lat: aux.geo.lat / DEG, lon: aux.geo.lon / DEG }, targetLatLon(this.target));
  }

  /**
   * One predictor-corrector cycle. Range: how far to bank (the vertical part of the lift, lift x
   * cos(bank), sets the range; predicted with that alone, since reversals cancel the sideways
   * part). Crossrange: the target's distance from the current flight plane; bank toward its
   * side, reversing when it outgrows a deadband that narrows as the ship slows.
   */
  private guideEntry(ship: Vehicle, aux: Aux): void {
    const goal = targetLatLon(this.target);
    const goalEcef = geodeticToEcef(goal.lat * DEG, goal.lon * DEG, 0);
    const predict = (bank: number) => {
      const model: EntryModel = { dragArea: SHIP_ENTRY_MODEL.dragArea, liftToDrag: (sp) => SHIP_ENTRY_MODEL.liftToDrag!(sp) * Math.cos(bank) };
      const p = predictTrajectory('guide', ship.r, ship.v, this.sim.t, model, aux.mp.mass);
      if (!p.impact || p.points.length < 3) return null;
      const P = p.impact.ecef;
      const prev = p.points[Math.max(0, p.points.length - 6)];
      const upP = normalize(P);
      let fwd = sub(P, prev);
      fwd = normalize(sub(fwd, scale(upP, dot(fwd, upP))));
      return { down: dot(sub(goalEcef, P), fwd), lat: p.impact.lat, lon: p.impact.lon };
    };
    // Range: bisection on the bank's size (more bank, less lift up, shorter).
    const full = predict(0);
    let at = full;
    if (full && full.down > 0) {
      // Even full lift up falls short: fly lift up (the most range there is).
      this.bank = 0;
    } else {
      let lo = 0;
      let hi = 85 * DEG;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        const f = predict(mid);
        if (!f) break;
        if (f.down > 0) hi = mid;
        else lo = mid;
      }
      this.bank = (lo + hi) / 2;
      at = predict(this.bank);
    }
    if (!at) return;
    // Crossrange: the target's distance from the flight plane (Earth-relative), + = to the left.
    const t = this.sim.t;
    const rE = eciToEcef(ship.r, t);
    const vE = eciToEcef(airRelativeVelocity(ship.r, ship.v), t);
    const n = normalize(cross(rE, vE));
    const crossKm = Math.asin(clamp(dot(normalize(goalEcef), n), -1, 1)) * 6371;
    const speed = norm(vE);
    const deadband = 1 + 0.004 * speed; // km: ~30 km at orbital speed, ~2 km at 250 m/s
    const want = crossKm >= 0 ? 1 : -1;
    // Late in the entry the range is often sorted and needs little bank, which leaves no lift to
    // take out a crossrange error with: bank at least enough toward the target to fly it out.
    if (speed < 3000 && Math.abs(crossKm) > 1) {
      const minBank = Math.min(30 * DEG, (Math.abs(crossKm) - 1) * 2 * DEG);
      if (this.bank < minBank) {
        this.bank = minBank;
        if (want !== this.bankSign && Math.abs(crossKm) > 3) {
          this.bankSign = want;
          this.log(`Return: bank toward the target (${crossKm.toFixed(0)} km crossrange)`);
        }
      }
    }
    if (want !== this.bankSign && Math.abs(crossKm) > deadband && this.bank > 5 * DEG) {
      this.bankSign = want;
      this.log(`Return: bank reversal (${crossKm.toFixed(0)} km crossrange)`);
    }
    const miss = greatCircleKm(at, goal);
    this.predicted = { lat: at.lat, lon: at.lon, missKm: Math.hypot(miss, crossKm) };
    this.status = `entry: bank ${((this.bank * this.bankSign) / DEG).toFixed(0)} deg, ${(at.down / 1000).toFixed(0)} km downrange / ${crossKm.toFixed(0)} km crossrange to go`;
  }

  /**
   * Light the engines when stopping (all of the speed, horizontal too) plus time for the flip
   * needs ~35% of 3 engines.
   */
  private shouldFlip(ship: Vehicle, aux: Aux, hAbove: number, down: number, speed: number): boolean {
    if (down < 10) return false;
    const h = hAbove - this.flipHeight(ship, aux, down, speed);
    return h <= 0 && hAbove < FLIP_HEIGHT * 3 + this.stopHeight();
  }

  /** Height above the surface to start the flip and landing burn at, at this speed. */
  private flipHeight(ship: Vehicle, aux: Aux, down: number, speed: number): number {
    const perEngine = engineThrust(ship.engines[0].place.type, 1, aux.pAmb);
    const aNet = 0.35 * ((3 * perEngine) / aux.mp.mass);
    return this.stopHeight() + (speed * speed) / (2 * aNet) + down * 5;
  }

  private stopHeight(): number {
    return this.target.kind === 'tower' ? this.hoverBase() : 0;
  }

  /**
   * While the player flies it (falling, engines off): the lowest height (above the surface, m)
   * at which handing back still leaves the autopilot room to flip and make its approach.
   */
  handBackBy(ship: Vehicle, aux: Aux): number | null {
    // (Only once it's falling belly-first: during entry the speed is still bled off by the air.)
    if (this.phase !== 'bellyflop') return null;
    const vAir = airRelativeVelocity(ship.r, ship.v);
    const up = localBasisEci(aux.geo, this.sim.t).u;
    const down = -dot(vAir, up);
    return down > 10 ? this.flipHeight(ship, aux, down, norm(vAir)) : null;
  }

  /**
   * Too low and fast to stop above the tower, and too far off to come down beside it: give up the
   * catch and set down on open ground by the pad instead, where its sideways motion would carry
   * it anyway (pushed clear of the tower and the arms).
   */
  private divert(pos: V3, vel: V3): void {
    const pad = (this.target as { pad: number }).pad;
    const [me, mn] = MOUNTS[pad];
    const tw = TOWERS[pad];
    // Keep-out: the tower and the arms reaching over the mount.
    const c: V3 = [(me + tw[0]) / 2, (mn + tw[1]) / 2, 0];
    const keep = 45 + 40;
    // Where braking sideways at ~4 m/s^2 would stop it: displacement v |v| / (2 a).
    const k = Math.hypot(vel[0], vel[1]) / 8;
    let q: V3 = [pos[0] + vel[0] * k, pos[1] + vel[1] * k, 0];
    const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
    if (d < keep) {
      // Out the far side from the structures (away from the tower if it's right over them).
      const dir: V3 = d > 1 ? [(q[0] - c[0]) / d, (q[1] - c[1]) / d, 0] : awayFromTower(pad);
      q = [c[0] + dir[0] * keep, c[1] + dir[1] * keep, 0];
    }
    this.arms?.command({ angle: ARMS.openDeg });
    const g = ecefToGeodetic(eciToEcef(padToEci(q, this.sim.t), this.sim.t));
    this.target = { kind: 'ground', lat: g.lat / DEG, lon: g.lon / DEG };
    this.log(`Return: too low and fast for the tower approach: diverting to land beside Pad ${pad + 1}`);
  }

  /**
   * Ship base height (above the pad ground) for the hover over the catch point: the whole ship
   * just above the arms' rails (then down between them, wide open, like the booster).
   */
  private hoverBase(): number {
    const arms = this.arms;
    return arms ? arms.top + HOVER_CLEAR : 0;
  }

  /** Flip, landing burn to the target, and (tower) the hover and descent onto the arms. */
  private landingBurn(ship: Vehicle, aux: Aux, dt: number, axis: V3, up: V3, baseHeight: number): void {
    const fr = this.frame();
    const pos = fr.pos(ship.r);
    const vel = fr.vel(ship.r, ship.v);
    const tgt = fr.target;
    const tower = this.target.kind === 'tower';
    const surface = this.surfaceHeight();
    // Base height in the pad frame (up = pad up, near enough).
    const base = baseHeight - surface;
    // Catch pins, in the frame. (Axis: the frame's up is the local vertical, near enough.)
    const axisPad = fr.dirIn(axis);
    const pinPos = add(pos, scale(axisPad, SHIP_CATCH_PIN - (aux.mp.xcg - ship.stages[0].def.xBase)));
    // Tower: the catch pins (body +-z) must point across the arms' gap to come down on the
    // rails. Roll to whichever way round is nearer, and how far off that is now.
    let rollRef: V3 | null = null;
    let rollErr = 0;
    if (tower) {
      const gap = catchGap((this.target as { pad: number }).pad);
      const z = fr.dirIn(qrot(ship.q, [0, 0, 1]));
      const zh = Math.hypot(z[0], z[1]);
      const c = zh > 1e-6 ? (z[0] * gap[0] + z[1] * gap[1]) / zh : 0;
      rollErr = Math.acos(clamp(Math.abs(c), 0, 1));
      this.rollErr = rollErr;
      // (Only in the hover: through the flip and landing burn the gimbals are busy steering.)
      if (this.phase === 'terminal') rollRef = fr.dir(c >= 0 ? gap : scale(gap, -1));
    }
    const pinVel = this.pinVelocity(pinPos, dt);
    // Steer the centre of mass (upright, the pins sit right above it): steering by the pins, high
    // up, chases itself, as the lean swings them the other way first.
    const ref = pos;
    const refVel = vel;
    void pinVel;
    const aimAt = tgt;
    const off: V3 = [aimAt[0] - ref[0], aimAt[1] - ref[1], 0];
    const offDist = Math.hypot(off[0], off[1]);
    // Tower: only at the staging point may it come down to the approach height (hull level with
    // the arms); anywhere else it stays above everything, the tower's top included.
    // (The landing burn judges by where it's heading: the zero-effort miss at the end of the burn.)
    let arriveOff = offDist;
    if (this.phase !== 'terminal') {
      const hLeft = Math.max(0.5, base - this.hoverBase());
      const tLeft = Math.max(1, (2 * hLeft) / Math.max(0.5, -vel[2]));
      // (Plus the distance it takes to stop moving sideways, at the ~3 m/s^2 a small lean gives.)
      const vh2 = vel[0] * vel[0] + vel[1] * vel[1];
      arriveOff = Math.hypot(off[0] - vel[0] * tLeft * 0.5, off[1] - vel[1] * tLeft * 0.5) + vh2 / 6;
    }
    const stop = tower ? (arriveOff > APPROACH_OFF ? TRANSIT_BASE : this.hoverBase()) : 0;
    let aCmd: V3;
    if (this.phase !== 'terminal') {
      // Vertical: constant deceleration to arrive at the stop height at ~2 m/s. Horizontal:
      // steer onto the target over the remaining time.
      const h = Math.max(0.5, base - stop);
      const down = Math.max(0.5, -vel[2]);
      const tGo = Math.max(1, (2 * h) / down);
      // (Rising: ease off.)
      let aUp = vel[2] > 0 ? 9.8 - 1.5 * vel[2] : Math.max(0, down * down - 4) / (2 * h) + 9.8;
      // Below where it should be (e.g. told to go over the tower): climb.
      if (base < stop - 1) aUp = 9.8 + 1.2 * (clamp(0.3 * (stop - base), 0, 6) - vel[2]);
      // Horizontal: onto the target with the time left; close to the surface (ocean) the aim
      // fades and it just stops moving sideways: arriving level beats arriving on the spot.
      // Arrive there with no sideways speed left (zero-effort miss / velocity law):
      // a = 6 x / t^2 - 4 v / t.
      const aim = tower ? 1 : clamp((h - 40) / 250, 0, 1);
      // Tower: close in at a speed that shrinks with the distance left (a first-order approach,
      // with the time constant tied to the time to go): the zero-effort-miss law, re-aimed as the
      // vertical profile's time estimate changes, swings through the target and back.
      const tau = clamp(0.4 * tGo, 4, 10);
      const k = tower
        ? (x: number, v: number) => clamp(0.67 * (clamp(x / tau, -30, 30) - v), -9, 9)
        : (x: number, v: number) => clamp(aim * ((6 * x) / (tGo * tGo) - (4 * v) / tGo) - (1 - aim) * 0.8 * v, -9, 9);
      aCmd = [k(off[0], refVel[0]), k(off[1], refVel[1]), aUp];
      if (this.phase === 'flip' && dot(axis, up) > Math.cos(25 * DEG)) this.phase = 'landing';
      // (Only gently: anything faster is a crash, which the sim's ground contact deals with.)
      if (!tower && down < 6 && (base <= 0.3 || (down < 0.3 && base < 3))) {
        setThrottle(ship, 'ship', 0);
        this.phase = 'landed';
        if (this.target.kind === 'ocean') this.log(`Splashdown! (${down.toFixed(1)} m/s, ${Math.hypot(vel[0], vel[1]).toFixed(1)} m/s sideways)`);
        this.log(`Return: ${this.target.kind === 'ground' ? 'touchdown' : 'splashdown'} ${(Math.hypot(off[0], off[1])).toFixed(0)} m from the target at ${down.toFixed(1)} m/s`);
        ship.status = 'landed';
        return;
      }
      // Into the hover only once it's all but stopped sideways (next to the tower there's no room to brake).
      // Falling too fast to stop above the tower's height, and not lined up for the approach
      // beside it: divert.
      if (tower) {
        const perEngine = engineThrust(ship.engines[0].place.type, 1, aux.pAmb);
        const aMax = Math.max(1, 0.8 * ((3 * perEngine) / aux.mp.mass) - 9.8);
        const baseStop = base - (vel[2] < 0 ? (vel[2] * vel[2]) / (2 * aMax) : 0);
        if (vel[2] < -10 && baseStop < TRANSIT_BASE && arriveOff > 40) {
          this.divert(pos, vel);
          return;
        }
      }
      if (tower && base - stop < 8 && Math.abs(vel[2]) < 3 && Math.hypot(vel[0], vel[1]) < 3 && offDist < APPROACH_OFF && this.phase === 'landing') {
        this.phase = 'terminal';
        // The tower opens its arms wide for the ship's arrival.
        this.arms?.command({ angle: ARMS.maxOpenDeg, slew: 0 });
        this.log(`Return: hovering by the tower, ${offDist.toFixed(0)} m from the catch point`);
      }
    } else {
      // Terminal (tower): hold height above the arms until the pins are lined up over the
      // catch point, then sink onto the rails.
      const arms = this.arms!;
      const pinAbove = pinPos[2] - arms.top;
      const tiltNow = Math.acos(clamp(axisPad[2], -1, 1));
      const lined = offDist < 2 && Math.hypot(refVel[0], refVel[1]) < 0.6 && tiltNow < 3 * DEG && rollErr < PIN_ROLL_CLOSE;
      // The hull goes down between the arms (wide open, they're ~16 m out: within ~6 m of the
      // catch point it clears them); outside that it stays above the rails. The last 12 m of
      // the pins' descent waits for a clean line-up, as the arms close then.
      // Height: over the catch point (within 6 m: the open arms clear the hull by ~12 m) come
      // down between the arms, pausing with the pins 10 m over the rails until lined up and the
      // arms close; once they're on the hull, onto the rails. Further off, stay above
      // everything (the tower's top too) if far, or just above the arms if near.
      const transitPin = TRANSIT_BASE + SHIP_CATCH_PIN - arms.top;
      const hoverPin = HOVER_CLEAR + SHIP_CATCH_PIN;
      let pinGoal: number;
      if (arms.contact) pinGoal = -1;
      else if (offDist < 6) pinGoal = lined || this.closing ? 10 : Math.max(10, Math.min(pinAbove, hoverPin));
      else pinGoal = offDist > 25 ? transitPin : Math.max(hoverPin, Math.min(pinAbove, transitPin));
      if (offDist < 6 && !lined && !this.closing && !arms.contact && pinAbove > 12) pinGoal = 10;
      const vzCmd = clamp(0.5 * (pinGoal - pinAbove), arms.contact ? -1.5 : -3, 3);
      // Toward the catch point at a capped speed (the lean near the arms is small, so a plain
      // position loop saturates and swings through), then hold it there. Close in, a slow
      // integral trims the steady push of two off-centre engines; only while the lean has room.
      const vMax = offDist > 8 ? 3 : 1.5;
      const horiz = (i: 0 | 1) => 0.7 * (clamp(0.25 * off[i], -vMax, vMax) - refVel[i]) + 0.05 * this.intOff[i];
      const leanRoom = Math.hypot(horiz(0), horiz(1)) < 0.8 * 9.8 * Math.tan(TERMINAL_NEAR_TILT);
      if (offDist < 3 && leanRoom) {
        this.intOff[0] = clamp(this.intOff[0] + off[0] * dt, -12, 12);
        this.intOff[1] = clamp(this.intOff[1] + off[1] * dt, -12, 12);
      }
      aCmd = [horiz(0), horiz(1), 1.4 * (vzCmd - vel[2]) + 9.8];
      this.checkCatch(ship, pinPos, pinAbove, offDist, vel, axisPad);
      if (this.phase !== 'terminal') return;
      this.status = `catch: pins ${pinAbove.toFixed(1)} m above the rails, ${offDist.toFixed(1)} m off, roll ${(rollErr / DEG).toFixed(0)}° off the rails`;
    }
    // Thrust: magnitude and direction (lean limited).
    let dirH: V3 = [aCmd[0], aCmd[1], 0];
    // Near the arms, stay almost upright: the ship is centred by its pins near the top, so a lean
    // swings its base sideways into the arms.
    const nearArms = this.phase === 'terminal' && this.arms && base < this.arms.top + 3 && offDist < 40;
    const maxH = Math.max(0.5, aCmd[2]) * Math.tan(this.phase === 'terminal' ? (nearArms ? TERMINAL_NEAR_TILT : TERMINAL_TILT) : LANDING_TILT);
    const hMag = Math.hypot(dirH[0], dirH[1]);
    if (hMag > maxH) dirH = scale(dirH, maxH / hMag);
    const want: V3 = [dirH[0], dirH[1], Math.max(0.5, aCmd[2])];
    const force = aux.mp.mass * norm(want);
    const type = ship.engines[0].place.type;
    const perEngine = engineThrust(type, 1, aux.pAmb);
    // Engines lit: as many as the thrust needs, but no more than can throttle down to it (three
    // Raptors at their minimum out-push a nearly empty ship: it would climb away).
    // With hysteresis: switching engines jolts the thrust (and, off-centre, the attitude).
    let lit = this.lit;
    if (this.phase !== 'flip') {
      const minT = type.minThrottle * perEngine;
      if (lit === 3 && force < 3 * minT * 0.95) lit = 2;
      else if (lit === 2 && force > 2 * perEngine * 1.02) lit = 3;
      else if (lit === 2 && force < 2 * minT * 0.8) lit = 1;
      else if (lit === 1 && force > perEngine * 0.95) lit = 2;
      if (lit !== this.lit) {
        this.lit = lit;
        if (!this.oneEngine && lit < 3) {
          this.oneEngine = true;
          this.log(`Return: down to ${lit} engine${lit > 1 ? 's' : ''} for the hover`);
        }
      }
    }
    // Through the flip the thrust points sideways: low throttle until it's within ~50 deg of
    // upright, so the flip itself doesn't throw the ship sideways.
    const upright = dot(axis, up);
    const thr =
      this.phase === 'flip' && upright < Math.cos(50 * DEG)
        ? type.minThrottle
        : clamp(throttleForThrust(type, force / lit, aux.pAmb), type.minThrottle, 1);
    const rsl = ship.engines.filter((e) => e.place.ring === 0);
    rsl.forEach((e, i) => (e.throttleCmd = i < lit ? thr : 0));
    for (const e of ship.engines) if (e.place.ring !== 0) e.throttleCmd = 0;
    const gains = this.phase === 'terminal' ? { wn: 1.6, zeta: 1.0, rollDamp: 0.5 } : { wn: 1.2, zeta: 1.0, rollDamp: 0.5 };
    applyControl(ship, aux, fr.dir(normalize(want)), dt, gains, rollRef);
    if (this.phase !== 'terminal') this.status = `landing burn: ${(base - stop).toFixed(0)} m to go, ${offDist.toFixed(0)} m off`;
    if (ship.stages[0].prop <= 0) {
      this.phase = 'lost';
      this.log('Return: out of propellant');
    }
  }

  private pinVelocity(pin: V3, dt: number): V3 {
    const prev = this.lastPin;
    this.lastPin = pin;
    if (!prev) return [0, 0, 0];
    const raw: V3 = [(pin[0] - prev[0]) / dt, (pin[1] - prev[1]) / dt, (pin[2] - prev[2]) / dt];
    const k = Math.min(1, dt / 0.15);
    this.pinVel = add(scale(this.pinVel, 1 - k), scale(raw, k));
    return this.pinVel;
  }

  /** The tower closes its arms on a ship settling in beside them, and catches it by the pins. */
  private checkCatch(ship: Vehicle, pin: V3, pinAbove: number, off: number, vel: V3, axisPad: V3): void {
    const arms = this.arms!;
    const pad = (this.target as { pad: number }).pad;
    // Close only on a ship centred and still: a closing arm pushes whatever it meets, and an
    // off-centre ship gets pushed out of the V.
    const still = Math.hypot(vel[0], vel[1]) < 0.6 && Math.abs(vel[2]) < 1.5;
    if (!this.closing && pinAbove < 12 && pinAbove > -1 && off < 2 && still && this.rollErr < PIN_ROLL_CLOSE) {
      this.closing = true;
      arms.command({ angle: 0 });
      this.log(`Pad ${pad + 1} chopsticks closing on the ship`);
    }
    if (pinAbove <= 0.05) {
      const tilt = Math.acos(clamp(axisPad[2], -1, 1));
      if (arms.contact && off < CAPTURE_RADIUS && Math.abs(vel[2]) < 2.5 && tilt < 3 * DEG && this.rollErr < PIN_ROLL_CATCH) {
        setThrottle(ship, 'ship', 0);
        this.phase = 'caught';
        ship.status = 'caught';
        ship.caughtPad = pad;
        ship.catchPin = SHIP_CATCH_PIN;
        this.log(`Ship caught by the Pad ${pad + 1} tower! (${off.toFixed(2)} m off center, ${Math.abs(vel[2]).toFixed(1)} m/s)`);
      } else if (pinAbove < -1.5 && arms.contact) {
        // The pins went past the rails without landing on them: it slides down through the arms.
        setThrottle(ship, 'ship', 0);
        this.phase = 'lost';
        const why = this.rollErr >= PIN_ROLL_CATCH ? `rolled ${(this.rollErr / DEG).toFixed(0)}° off the rails` : `${off.toFixed(1)} m off center`;
        this.log(`Ship's catch pins missed the rails (${why})`);
      }
    }
    void pin;
  }
}

/** Turn a horizontal direction toward another about `up`, by at most `maxAngle` (rad). */
function turnToward(from: V3, to: V3, up: V3, maxAngle: number): V3 {
  const f = normalize(sub(from, scale(up, dot(from, up))));
  const t = normalize(sub(to, scale(up, dot(to, up))));
  const ang = Math.atan2(dot(cross(f, t), up), dot(f, t));
  const a = clamp(ang, -maxAngle, maxAngle);
  const side = cross(up, f);
  return normalize(add(scale(f, Math.cos(a)), scale(side, Math.sin(a))));
}

/**
 * Belly-flop attitude: belly (body +y) square into the oncoming flow, nose pointing the way to
 * glide (projected square to the flow), then tilted toward the flow by `tilt` (nose down when
 * falling): the flat body's force leans that way.
 */
function glideAttitude(vHat: V3, toward: V3, tilt: number): { nose: V3; bodyZ: V3 } {
  let n0 = sub(toward, scale(vHat, dot(toward, vHat)));
  n0 = norm(n0) > 1e-3 ? normalize(n0) : normalize(cross(vHat, [0, 0, 1]));
  const nose = normalize(add(scale(n0, Math.cos(tilt)), scale(vHat, Math.sin(tilt))));
  const bodyY = normalize(sub(vHat, scale(nose, dot(vHat, nose))));
  return { nose, bodyZ: cross(nose, bodyY) };
}

function qx(v: Vehicle): V3 {
  const q = v.q;
  return [1 - 2 * (q[2] * q[2] + q[3] * q[3]), 2 * (q[1] * q[2] + q[0] * q[3]), 2 * (q[1] * q[3] - q[0] * q[2])];
}

function fmt(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

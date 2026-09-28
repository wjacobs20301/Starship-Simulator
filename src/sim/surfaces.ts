// Aerodynamic control surfaces as physical parts: Starship's four flaps and Super Heavy's three
// grid fins. Each has a hinge on the hull, an angle moved by an actuator at a limited rate, and
// makes its own force (from its area, its angle to the local airflow and whether the hull
// shelters it) at its own place on the vehicle. The control system steers by choosing angles
// (control.ts); the physics only ever sees the forces those angles make.
//
// Flaps (flat plates hinged along the hull's side, at the belly / leeward line):
//   angle 0  folded back against the leeward (steel, body -y) side: edge-on, sheltered
//   angle 90 deg  straight out sideways: broadside to a belly-first (+y) flow
// A flap's drag is what it does: more deployed = more drag at that corner of the ship.
//
// Grid fins (lattice fins sticking out radially): angle 0 = the fin's plane contains the
// vehicle axis; turning it about its radial hinge makes lift like a small wing, in either flow
// direction (they work engines-first on a returning booster).

import { type V3, add, cross, dot, norm, scale, sub } from './math';

export type SurfaceKind = 'flap' | 'gridfin';

export interface SurfaceDef {
  /** Model node name (the render animates it). */
  name: string;
  kind: SurfaceKind;
  /** Hinge point in the stage's frame: x from the stage base, then body y, z (m). */
  hinge: V3;
  /** Hinge axis (unit, body frame; for grid fins the outward radial). */
  axis: V3;
  /** Flaps: which side of the ship (+1 = body +z). */
  side?: 1 | -1;
  /** Planform area, m^2, and hinge-to-centre-of-pressure distance, m. */
  area: number;
  arm: number;
  /** Travel limits and neutral (rad), actuator rate (rad/s). */
  min: number;
  max: number;
  neutral: number;
  /** Where it sits while its stage is still stacked (on the pad and through the climb), rad; else neutral. */
  parked?: number;
  rate: number;
}

const DEG = Math.PI / 180;

/** A surface ready for force evaluation: body-frame hinge (x already offset by the stage base). */
export interface SurfaceInstance {
  def: SurfaceDef;
  /** Hinge point, body frame. */
  hinge: V3;
}

/** Where the flow is coming from and how hard: body-frame unit velocity through the air, q, Mach. */
export interface Flow {
  vHat: V3;
  q: number;
  mach: number;
}

/**
 * Plate normal (unit) and centre of pressure offset from the hinge (body frame) at an angle.
 */
function geometry(s: SurfaceInstance, angle: number): { n: V3; arm: V3; span: V3 } {
  const d = s.def;
  if (d.kind === 'flap') {
    // Plate direction from the hinge: folded back (leeward, -y) at 0, out sideways at 90 deg,
    // square to the (possibly tilted) hinge axis.
    const side = d.side ?? 1;
    const ret: V3 = [0, -1, 0];
    const dep: V3 = [0, 0, side];
    let span = add(scale(ret, Math.cos(angle)), scale(dep, Math.sin(angle)));
    span = sub(span, scale(d.axis, dot(span, d.axis)));
    span = scale(span, 1 / norm(span));
    const n = cross(d.axis, span);
    return { n, arm: scale(span, d.arm), span };
  }
  // Grid fin: plane contains the radial (hinge) axis; at 0 its normal is tangential.
  const r = d.axis;
  const n0 = cross([1, 0, 0], r);
  const n: V3 = add(scale(n0, Math.cos(angle)), scale([1, 0, 0], Math.sin(angle)));
  return { n, arm: scale(r, d.arm), span: r };
}

/** Flat-plate normal force coefficient for the sine of the plate's angle to the flow. */
function plateCoefficient(sinA: number, mach: number): number {
  // Newtonian 2 sin^2 hypersonic, easing to a subsonic flat plate (~1.2 broadside).
  const c = mach > 2 ? 2 : mach < 0.8 ? 1.2 : 1.2 + (0.8 * (mach - 0.8)) / 1.2;
  return c * sinA * Math.abs(sinA);
}

/** Lattice-fin normal force coefficient: strong at small angles, stalling toward broadside. */
function gridFinCoefficient(sinA: number): number {
  const a = Math.asin(Math.max(-1, Math.min(1, sinA)));
  return 2.2 * Math.sin(a) * Math.abs(Math.cos(a)) + 0.4 * sinA * Math.abs(sinA);
}

/**
 * Force (body frame, N) and torque about the CG (N m) of one surface at an angle, in a flow.
 * xcg: body-frame x of the centre of mass.
 */
export function surfaceLoad(s: SurfaceInstance, angle: number, flow: Flow, xcg: number): { f: V3; t: V3 } {
  if (flow.q <= 0) return { f: [0, 0, 0], t: [0, 0, 0] };
  const g = geometry(s, angle);
  const v = flow.vHat;
  const sinA = dot(g.n, v);
  let coef: number;
  if (s.def.kind === 'flap') {
    // A flap tucked behind the hull (its plate pointing downstream of the flow across the
    // body) sits in the hull's wake.
    const cross2 = sub(v, scale([1, 0, 0], v[0]));
    const c = norm(cross2);
    const lee = c > 1e-6 ? dot(g.span, scale(cross2, 1 / c)) : 0;
    const exposed = smoothstep(-0.9, -0.2, lee) * Math.min(1, c * 2) + (1 - Math.min(1, c * 2));
    coef = plateCoefficient(sinA, flow.mach) * exposed;
  } else {
    coef = gridFinCoefficient(sinA);
  }
  // Pressure pushes the plate back against the vehicle's motion through the air.
  const f = scale(g.n, -flow.q * s.def.area * coef);
  const p = add(s.hinge, g.arm);
  const t = cross([p[0] - xcg, p[1], p[2]], f);
  return { f, t };
}

function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/** All surfaces' force and torque at the given angles. */
export function surfaceLoads(list: SurfaceInstance[], angles: number[], flow: Flow, xcg: number): { f: V3; t: V3 } {
  const f: V3 = [0, 0, 0];
  const t: V3 = [0, 0, 0];
  list.forEach((s, i) => {
    const l = surfaceLoad(s, angles[i], flow, xcg);
    for (let k = 0; k < 3; k++) {
      f[k] += l.f[k];
      t[k] += l.t[k];
    }
  });
  return { f, t };
}

// --- The vehicles' surfaces (hinges from the models, see art/blender/vehicle_import.py) --------

const flap = (name: string, side: 1 | -1, fwd: boolean): SurfaceDef =>
  fwd
    ? {
        name,
        kind: 'flap',
        side,
        // Forward flaps hinge up the nosecone's taper.
        hinge: [45.4, -1.12, side * 3.38],
        axis: [0.957, 0, -side * 0.29],
        area: 23,
        arm: 2.2,
        min: 0,
        max: 95 * DEG,
        neutral: 55 * DEG,
        // On the stack, as on the pad (the model's pose): forward flaps swept back part way, aft
        // flaps straight out; to the belly-flop neutral once the ship flies alone.
        parked: 40 * DEG,
        rate: 25 * DEG,
      }
    : {
        name,
        kind: 'flap',
        side,
        hinge: [5.7, -0.17, side * 4.77],
        axis: [1, 0, 0],
        area: 42,
        arm: 1.9,
        min: 0,
        max: 95 * DEG,
        neutral: 55 * DEG,
        parked: 90 * DEG,
        rate: 25 * DEG,
      };

export const SHIP_SURFACES: SurfaceDef[] = [flap('Flap_Fwd_L', 1, true), flap('Flap_Fwd_R', -1, true), flap('Flap_Aft_L', 1, false), flap('Flap_Aft_R', -1, false)];

const fin = (name: string, radial: V3): SurfaceDef => ({
  name,
  kind: 'gridfin',
  hinge: [65.5, radial[1] * 4.23, radial[2] * 4.23],
  axis: radial,
  area: 15,
  arm: 2.3,
  min: -25 * DEG,
  max: 25 * DEG,
  neutral: 0,
  rate: 30 * DEG,
});

export const BOOSTER_SURFACES: SurfaceDef[] = [fin('GridFin_Catch_A', [0, 0, 1]), fin('GridFin_Catch_B', [0, 0, -1]), fin('GridFin_Rudder', [0, 1, 0])];

// Collisions between vehicles and the launch towers: the chopsticks (as the real arm shapes, at
// their current height and opening) and the tower itself. Vehicles are cylinders along their
// axis. Everything here is in Pad 1's ENU frame (m), the frame padFrame.ts converts to.

import { type V3, add, dot, norm, scale, sub } from './math';
import { PAD, PAD2 } from './constants';
import { PAD_COLLIDERS } from './padColliders';

/** Hull radius of Super Heavy / Starship, m. */
export const HULL_RADIUS = 4.5;
/** Half the width of an arm column (the export's cell size / 2), m. */
const COLUMN_HALF = 0.4;
/** Beyond this distance from a pad's hinge, a vehicle can't reach that pad's arms, m. */
const ARM_REACH = 48;

export type ArmSide = 'L' | 'R';
export type Structure = 'armL' | 'armR' | 'tower' | 'qd';

/** A vehicle as a cylinder from its base to its top (pad ENU). */
export interface Cylinder {
  a: V3;
  b: V3;
  r: number;
}

export interface Contact {
  pad: number;
  what: Structure;
  /** How far the vehicle is inside the structure, m. */
  depth: number;
  /** Unit direction to push the vehicle out (pad ENU). */
  normal: V3;
  /** Where they touch (pad ENU). */
  point: V3;
}

/** The state of one tower as the collision model needs it. */
export interface TowerState {
  offset: number;
  angle: number;
  broken: Record<ArmSide, boolean>;
  down: boolean;
  /** Both arms' swing about the carriage (deg). */
  slew: number;
  /** Ship QD arm swing (deg) and whether it's wrecked. */
  qd: number;
  qdBroken: boolean;
}

// glTF (x, y, z) -> pad ENU (e, n, u) = (x, -z, y).
const toEnu = (x: number, y: number, z: number): V3 => [x, -z, y];

/** Carriage yaw (rotation about up) from its quaternion. */
const yawOf = (q: number[]) => 2 * Math.atan2(q[1], q[3]);

/** Hinge position (pad ENU) at the carriage's home height, per pad. */
const HINGES: V3[] = PAD_COLLIDERS.map((p) => toEnu(p.carriage.pos[0], p.carriage.pos[1], p.carriage.pos[2]));

/**
 * Columns [x, z, y0, y1] given in a hinge's frame (turning about glTF y) placed in pad ENU: flat
 * array of [e, n, uBottom, uTop] per column, the hinge at `pos` (glTF) with yaw `yaw`, swung by
 * `th` (rad), raised by `lift` (m).
 */
function placeColumns(cols: number[][], pos: number[], yaw: number, th: number, lift: number): Float64Array {
  const [cx, cy, cz] = pos;
  const c1 = Math.cos(th), s1 = Math.sin(th);
  const c2 = Math.cos(yaw), s2 = Math.sin(yaw);
  const out = new Float64Array(cols.length * 4);
  for (let i = 0; i < cols.length; i++) {
    const [x, z, y0, y1] = cols[i];
    // Swing about the hinge, then the hinge's yaw (both about y; glTF rotation sense).
    const xa = x * c1 + z * s1;
    const za = -x * s1 + z * c1;
    const xw = xa * c2 + za * s2 + cx;
    const zw = -xa * s2 + za * c2 + cz;
    out[i * 4] = xw;
    out[i * 4 + 1] = -zw;
    out[i * 4 + 2] = cy + lift + y0;
    out[i * 4 + 3] = cy + lift + y1;
  }
  return out;
}

/**
 * One arm's columns in pad ENU at this carriage offset (m) and opening (deg): flat array of
 * [e, n, uBottom, uTop] per column. L turns by +angle, R by -angle (as the model is animated).
 */
export function armColumns(pad: number, side: ArmSide, offset: number, angleDeg: number, slewDeg = 0): Float64Array {
  const p = PAD_COLLIDERS[pad];
  const th = (((side === 'L' ? 1 : -1) * angleDeg + slewDeg) * Math.PI) / 180;
  return placeColumns(p.arms[side], p.carriage.pos, yawOf(p.carriage.rot), th, offset);
}

/** The ship QD arm's columns in pad ENU at this swing (deg, as the model is animated). */
export function qdColumns(pad: number, angleDeg: number): Float64Array {
  const q = PAD_COLLIDERS[pad].qd;
  return placeColumns(q.columns, q.pos, yawOf(q.rot), (angleDeg * Math.PI) / 180, 0);
}

/** Closest points between segments p0-p1 and q0-q1: returns [s, t] parameters (0..1). */
function closestParams(p0: V3, p1: V3, q0: V3, q1: V3): [number, number] {
  const d1 = sub(p1, p0);
  const d2 = sub(q1, q0);
  const r = sub(p0, q0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  if (a < 1e-12 && e < 1e-12) return [0, 0];
  if (a < 1e-12) return [0, Math.min(1, Math.max(0, f / e))];
  const c = dot(d1, r);
  if (e < 1e-12) return [Math.min(1, Math.max(0, -c / a)), 0];
  const b = dot(d1, d2);
  const denom = a * e - b * b;
  s = denom > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
  t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = Math.min(1, Math.max(0, -c / a));
  } else if (t > 1) {
    t = 1;
    s = Math.min(1, Math.max(0, (b - c) / a));
  }
  return [s, t];
}

const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Whether a cylinder can reach a pad's arms at all (cheap rejection). */
function nearArms(pad: number, offset: number, cyl: Cylinder): boolean {
  const h = HINGES[pad];
  const hinge: V3 = [h[0], h[1], h[2] + offset - 10];
  const [s] = closestParams(cyl.a, cyl.b, hinge, hinge);
  const q = lerp3(cyl.a, cyl.b, s);
  return Math.hypot(q[0] - hinge[0], q[1] - hinge[1]) < ARM_REACH + cyl.r && Math.abs(q[2] - hinge[2]) < 40;
}

/** Deepest contact of a cylinder with one arm's columns (or null). */
export function armContact(pad: number, side: ArmSide, t: TowerState, cyl: Cylinder, angleDeg = t.angle): Contact | null {
  if (t.down || t.broken[side] || !nearArms(pad, t.offset, cyl)) return null;
  const cols = armColumns(pad, side, t.offset, angleDeg, t.slew);
  let best: Contact | null = null;
  const reach = cyl.r + COLUMN_HALF;
  for (let i = 0; i < cols.length; i += 4) {
    const q0: V3 = [cols[i], cols[i + 1], cols[i + 2]];
    const q1: V3 = [cols[i], cols[i + 1], cols[i + 3]];
    const [s, u] = closestParams(cyl.a, cyl.b, q0, q1);
    const pc = lerp3(cyl.a, cyl.b, s);
    const qc = lerp3(q0, q1, u);
    const d = sub(pc, qc);
    const dist = norm(d);
    const depth = reach - dist;
    if (depth <= 0 || (best && depth <= best.depth)) continue;
    // Push out sideways from the column (the arm is a thin vertical slab; its top is the catch rail).
    const horiz = Math.hypot(d[0], d[1]);
    const normal: V3 = horiz > 1e-6 ? [d[0] / horiz, d[1] / horiz, 0] : [1, 0, 0];
    best = { pad, what: side === 'L' ? 'armL' : 'armR', depth, normal, point: qc };
  }
  return best;
}

/** QD arm hinges (pad ENU) and reach, for a cheap rejection. */
const QD_HINGES: V3[] = PAD_COLLIDERS.map((p) => toEnu(p.qd.pos[0], p.qd.pos[1], p.qd.pos[2]));
const QD_REACH = 45;

/** Deepest contact of a cylinder with a tower's ship QD arm (or null). */
export function qdContact(pad: number, t: TowerState, cyl: Cylinder): Contact | null {
  if (t.down || t.qdBroken) return null;
  const h = QD_HINGES[pad];
  const [s] = closestParams(cyl.a, cyl.b, [h[0], h[1], h[2] + 5], [h[0], h[1], h[2] + 5]);
  const q = lerp3(cyl.a, cyl.b, s);
  if (Math.hypot(q[0] - h[0], q[1] - h[1]) > QD_REACH + cyl.r || Math.abs(q[2] - h[2] - 5) > 30) return null;
  const cols = qdColumns(pad, t.qd);
  let best: Contact | null = null;
  const reach = cyl.r + COLUMN_HALF;
  for (let i = 0; i < cols.length; i += 4) {
    const q0: V3 = [cols[i], cols[i + 1], cols[i + 2]];
    const q1: V3 = [cols[i], cols[i + 1], cols[i + 3]];
    const [sp, u] = closestParams(cyl.a, cyl.b, q0, q1);
    const pc = lerp3(cyl.a, cyl.b, sp);
    const qc = lerp3(q0, q1, u);
    const d = sub(pc, qc);
    const dist = norm(d);
    const depth = reach - dist;
    if (depth <= 0 || (best && depth <= best.depth)) continue;
    // A vehicle can come down onto it as well as against it: push out along the full separation.
    const normal: V3 = dist > 1e-6 ? scale(d, 1 / dist) : [0, 0, 1];
    best = { pad, what: 'qd', depth, normal, point: qc };
  }
  return best;
}

/** Deepest contact of a cylinder with a tower's lattice, base or plinth (oriented boxes; or null). */
export function towerContact(pad: number, t: TowerState, cyl: Cylinder): Contact | null {
  if (t.down) return null;
  let best: Contact | null = null;
  const len = norm(sub(cyl.b, cyl.a));
  const n = Math.max(2, Math.ceil(len / 2));
  for (const bx of PAD_COLLIDERS[pad].tower) {
    const c = Math.cos(bx.yaw);
    const s = Math.sin(bx.yaw);
    // Box frame: x along its first axis, y along its second, z up.
    const toLocal = (p: V3): V3 => {
      const de = p[0] - bx.e;
      const dn = p[1] - bx.n;
      return [de * c + dn * s, -de * s + dn * c, p[2]];
    };
    const toWorldDir = (d: V3): V3 => [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]];
    for (let i = 0; i <= n; i++) {
      const pw = lerp3(cyl.a, cyl.b, i / n);
      const p = toLocal(pw);
      const q: V3 = [Math.min(bx.a, Math.max(-bx.a, p[0])), Math.min(bx.b, Math.max(-bx.b, p[1])), Math.min(bx.u1, Math.max(bx.u0, p[2]))];
      const d = sub(p, q);
      const dist = norm(d);
      let depth: number;
      let normal: V3;
      if (dist > 1e-6) {
        depth = cyl.r - dist;
        normal = toWorldDir(scale(d, 1 / dist));
      } else {
        // Axis inside the box: out through the nearest side face.
        const exits: [number, V3][] = [
          [p[0] + bx.a, [-1, 0, 0]],
          [bx.a - p[0], [1, 0, 0]],
          [p[1] + bx.b, [0, -1, 0]],
          [bx.b - p[1], [0, 1, 0]],
        ];
        exits.sort((x, y) => x[0] - y[0]);
        depth = cyl.r + exits[0][0];
        normal = toWorldDir(exits[0][1]);
      }
      if (depth > 0 && (!best || depth > best.depth)) {
        const qw: V3 = [bx.e + q[0] * c - q[1] * s, bx.n + q[0] * s + q[1] * c, q[2]];
        best = { pad, what: 'tower', depth, normal, point: qw };
      }
    }
  }
  return best;
}

/** The deepest contact of a vehicle with any tower or arm. */
export function deepestContact(cyl: Cylinder, towers: TowerState[]): Contact | null {
  let best: Contact | null = null;
  towers.forEach((t, pad) => {
    for (const c of [armContact(pad, 'L', t, cyl), armContact(pad, 'R', t, cyl), qdContact(pad, t, cyl), towerContact(pad, t, cyl)]) {
      if (c && (!best || c.depth > best.depth)) best = c;
    }
  });
  return best;
}

/** A vehicle's hull cylinder from its base / top positions (pad ENU). */
export function cylinder(base: V3, axis: V3, length: number, r = HULL_RADIUS): Cylinder {
  return { a: base, b: add(base, scale(axis, length)), r };
}

/**
 * Launch mount centres (Pad 1 ENU, horizontal): from the pads' positions, placed exactly as the
 * pad model is built (scripts/export-geometry.ts: flat east / north offsets from Pad 1's mount).
 */
export const MOUNTS: [number, number][] = [PAD, PAD2].map((p) => [
  (p.lonDeg - PAD.lonDeg) * 111_320 * Math.cos((PAD.latDeg * Math.PI) / 180),
  (p.latDeg - PAD.latDeg) * 110_800,
]);
/** Half-width of the launch table on top of a mount, m. */
const MOUNT_HALF = 14;

/** Whether a point (pad ENU) is over one of the launch mounts. */
export function onLaunchMount(p: V3): boolean {
  return MOUNTS.some(([e, n]) => Math.hypot(p[0] - e, p[1] - n) < MOUNT_HALF);
}

/** Tower lattice centres (Pad 1 ENU, horizontal), Pad 1 then Pad 2. */
export const TOWERS: [number, number][] = MOUNTS.map(([e, n], i) => {
  const t = (i === 0 ? PAD : PAD2).tower;
  return [e + t.e, n + t.n];
});

/**
 * The line across the gap between a pad's arms (pad ENU, horizontal unit): square to the line
 * from the tower to the mount. Catch pins / catch fittings must point along it to land on the
 * rails.
 */
export function catchGap(pad: number): V3 {
  const [me, mn] = MOUNTS[pad];
  const [te, tn] = TOWERS[pad];
  const l = Math.hypot(me - te, mn - tn);
  return [-(mn - tn) / l, (me - te) / l, 0];
}

/** Away from a pad's tower, across its mount (pad ENU, horizontal unit). */
export function awayFromTower(pad: number): V3 {
  const [me, mn] = MOUNTS[pad];
  const [te, tn] = TOWERS[pad];
  const l = Math.hypot(me - te, mn - tn);
  return [(me - te) / l, (mn - tn) / l, 0];
}

/**
 * Where the arms hold a vehicle (pad ENU, horizontal), swung by `slewDeg` about the carriage's
 * pivot: the launch mount's centre at 0.
 */
export function catchPoint(pad: number, slewDeg: number): [number, number] {
  const [me, mn] = MOUNTS[pad];
  if (slewDeg === 0) return [me, mn];
  const [he, hn] = HINGES[pad];
  const a = (slewDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [he + (me - he) * c - (mn - hn) * s, hn + (me - he) * s + (mn - hn) * c];
}

/** Height of what's under a point (pad ENU) near the pads: a launch mount, or the ground (0). */
export function surfaceUnder(p: V3): number {
  return onLaunchMount(p) ? PAD.mountHeight : 0;
}

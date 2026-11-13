// Collision shapes for the towers and chopsticks, from the built pad model (public/models/pad.glb):
// each arm as vertical columns (plan-view cells with a height range) in its own hinge's frame, and the
// tower lattice, base and plinth as boxes. Writes src/sim/padColliders.ts for the physics.
//
//   npx tsx scripts/export-pad-colliders.ts      (after rebuilding the pad model)

import { writeFileSync } from 'node:fs';
import { type Node, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

/** Plan-view cell size for the arm columns, m. */
const CELL = 0.75;

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read('public/models/pad.glb');
const nodes = doc.getRoot().listNodes();
const node = (name: string): Node => {
  const n = nodes.find((x) => x.getName() === name);
  if (!n) throw new Error(`node ${name} not found`);
  return n;
};

type M4 = number[];
const mul = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const apply = (m: M4, p: number[]) => [0, 1, 2].map((k) => m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k]);

/**
 * Points over the surface of a node's mesh and its descendants', in the frame of `frame` (a local
 * matrix chain): its vertices, and points across every triangle no further apart than half a
 * cell. (The vertices alone did for the print kit's finely meshed arms; a beam built as a box has
 * eight, one at each end, and a 30 m arm of such beams was a few posts with air between: the
 * booster went through it.)
 */
function points(n: Node, m: M4, dense = true, out: number[][] = []): number[][] {
  for (const prim of n.getMesh()?.listPrimitives() ?? []) {
    const pos = prim.getAttribute('POSITION')!;
    const v: number[][] = [];
    for (let i = 0; i < pos.getCount(); i++) v.push(apply(m, pos.getElement(i, [])));
    for (const p of v) out.push(p);
    if (!dense) continue;
    const idx = prim.getIndices();
    const count = idx ? idx.getCount() : v.length;
    const at = (i: number) => v[idx ? idx.getScalar(i) : i];
    for (let t = 0; t + 2 < count; t += 3) {
      const [a, b, c] = [at(t), at(t + 1), at(t + 2)];
      const edge = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]));
      const k = Math.ceil(edge / (CELL / 2));
      if (k < 2) continue;
      for (let i = 0; i <= k; i++) {
        for (let j = 0; j <= k - i; j++) {
          const [u, w] = [i / k, j / k];
          out.push([0, 1, 2].map((d) => a[d] + (b[d] - a[d]) * u + (c[d] - a[d]) * w));
        }
      }
    }
  }
  for (const c of n.listChildren()) points(c, mul(m, c.getMatrix() as M4), dense, out);
  return out;
}

/** Vertical columns [x, z, yMin, yMax] covering a point cloud (pivot-local, glTF axes). */
function columns(pts: number[][]): number[][] {
  const cells = new Map<string, number[]>();
  for (const [x, y, z] of pts) {
    const key = `${Math.round(x / CELL)},${Math.round(z / CELL)}`;
    const c = cells.get(key);
    if (c) {
      c[2] = Math.min(c[2], y);
      c[3] = Math.max(c[3], y);
    } else cells.set(key, [Math.round(x / CELL) * CELL, Math.round(z / CELL) * CELL, y, y]);
  }
  return [...cells.values()].map((c) => c.map((v) => Math.round(v * 100) / 100));
}

/**
 * An oriented box around a node's mesh, in pad ENU (e = x, n = -z, u = y): the plan rectangle
 * of least area over rotations (the towers stand turned to their mounts), and its height range.
 */
function box(name: string): { e: number; n: number; a: number; b: number; yaw: number; u0: number; u1: number } {
  const n = node(name);
  // (Its corners are enough for a box round it.)
  const pts = points(n, n.getWorldMatrix() as M4, false).map(([x, y, z]) => [x, -z, y]);
  let best = { area: Infinity, yaw: 0, lo: [0, 0], hi: [0, 0] };
  for (let d = 0; d < 90; d += 0.25) {
    const yaw = (d * Math.PI) / 180;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const lo = [Infinity, Infinity];
    const hi = [-Infinity, -Infinity];
    for (const [e, nn] of pts) {
      const l = [e * c + nn * s, -e * s + nn * c];
      for (let k = 0; k < 2; k++) {
        lo[k] = Math.min(lo[k], l[k]);
        hi[k] = Math.max(hi[k], l[k]);
      }
    }
    const area = (hi[0] - lo[0]) * (hi[1] - lo[1]);
    if (area < best.area - 1e-6) best = { area, yaw, lo, hi };
  }
  const c = Math.cos(best.yaw);
  const s = Math.sin(best.yaw);
  const lc = [(best.lo[0] + best.hi[0]) / 2, (best.lo[1] + best.hi[1]) / 2];
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    e: r(lc[0] * c - lc[1] * s),
    n: r(lc[0] * s + lc[1] * c),
    a: r((best.hi[0] - best.lo[0]) / 2),
    b: r((best.hi[1] - best.lo[1]) / 2),
    yaw: r(best.yaw),
    u0: r(pts.reduce((m, p) => Math.min(m, p[2]), Infinity)),
    u1: r(pts.reduce((m, p) => Math.max(m, p[2]), -Infinity)),
  };
}

const pads = ['Pad1', 'Pad2'].map((p) => {
  const carriage = node(`${p}_Carriage`);
  const arm = (side: 'L' | 'R') => {
    const pivot = node(`${p}_Chopstick_${side}`);
    // Pivot-local: the arm mesh node's transform relative to its pivot (the pivot turns about its Y).
    return columns(points(pivot, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  };
  // Each arm's own hinge, in the carriage's frame (x, z).
  const hinge = (side: 'L' | 'R') => {
    const t = node(`${p}_Chopstick_${side}`).getTranslation();
    return [Math.round(t[0] * 1000) / 1000, Math.round(t[2] * 1000) / 1000];
  };
  const qd = node(`${p}_ShipQD`);
  return {
    carriage: { pos: carriage.getWorldTranslation().map((v) => Math.round(v * 1000) / 1000), rot: carriage.getWorldRotation() },
    arms: { L: arm('L'), R: arm('R') },
    hinges: { L: hinge('L'), R: hinge('R') },
    qd: {
      pos: qd.getWorldTranslation().map((v) => Math.round(v * 1000) / 1000),
      rot: qd.getWorldRotation(),
      columns: columns(points(qd, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
    },
    tower: [box(`${p}_Tower`), box(`${p}_Tower_Base`), box(`${p}_Tower_Plinth`)],
  };
});

const out = `// Generated by scripts/export-pad-colliders.ts from public/models/pad.glb. Do not edit.
// Render-world / glTF axes (x = east, y = up, z = -north), metres, Pad 1 ground point at the origin.

export interface PadCollider {
  /** The arms' carriage (hinge) at its home height: position and rotation (quaternion x, y, z, w). */
  carriage: { pos: number[]; rot: number[] };
  /** Each arm as vertical columns [x, z, yMin, yMax] in its hinge's frame (it turns about y). */
  arms: { L: number[][]; R: number[][] };
  /** Each arm's hinge [x, z] in the carriage's frame: either side of its centre. */
  hinges: { L: number[]; R: number[] };
  /** The ship quick-disconnect arm: its hinge (position, rotation) and columns in the hinge's frame. */
  qd: { pos: number[]; rot: number[]; columns: number[][] };
  /**
   * Tower lattice, base and plinth: oriented boxes in pad ENU: centre (e, n), half-sizes along
   * their own axes (a, b) turned by yaw (rad, counter-clockwise from east), height range u0..u1.
   */
  tower: { e: number; n: number; a: number; b: number; yaw: number; u0: number; u1: number }[];
}

export const PAD_COLLIDERS: PadCollider[] = ${JSON.stringify(pads)};
`;
writeFileSync('src/sim/padColliders.ts', out);
console.log(`wrote src/sim/padColliders.ts: ${pads.map((p) => `${p.arms.L.length}+${p.arms.R.length} arm columns, ${p.qd.columns.length} QD columns`).join(', ')}`);

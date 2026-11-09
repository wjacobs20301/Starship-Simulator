// The Starlink V3 satellites a Starlink flight deploys (sim/payload.ts), drawn from the Blender
// model (art/blender/starlink_v3.py: the bus, one solar panel, a wing yoke). Each one slides out
// of the ship's PEZ slot, drifts away turning slowly, and a couple of minutes later unfolds its
// two solar wings: each swings out over the side on its yoke, then opens out like an accordion
// to 20 m.
//
// All of them together are a handful of instanced meshes (one per part of the model), not
// hundreds of objects: 26 satellites x 20 panels each.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { M3, V3 } from '../sim/math';
import type { Snapshot } from '../sim/simulation';

/** The model's sizes (art/blender/starlink_v3.py), m. */
const BUS_W = 3.5;
const BUS_T = 0.3;
const PANEL_W = 2.02;
const PANEL_T = 0.025;
const PANELS = 10;
const STACK_T = PANELS * PANEL_T + 0.02;
const YOKE = 1.1;

/** When the wings deploy after release, s: swing out, then unfold. */
const SWING = [100, 160] as const;
const UNFOLD = [160, 400] as const;
/** Satellites farther than this from the camera aren't drawn, m. */
const DRAW_RANGE = 60e3;

interface Part {
  mesh: THREE.InstancedMesh;
  /** The part's place in its template (bus / panel / yoke frame). */
  local: THREE.Matrix4;
}

/** Load the model: the bus, the panel and the yoke, each with its meshes in their template frame. */
export async function loadStarlink(): Promise<THREE.Object3D> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/starlink_v3.glb`);
  return gltf.scene;
}

const smooth = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Blender coordinates (Z up) -> the model's (glTF, Y up). */
const B = (x: number, y: number, z: number, out = new THREE.Vector3()) => out.set(x, z, -y);

export class StarlinkFleet {
  readonly group = new THREE.Group();
  private bus: Part[] = [];
  private panel: Part[] = [];
  private yoke: Part[] = [];
  /** model -> ship body axes at release: its length across the slot (body z), its back toward the nose (body x). */
  private static readonly MODEL_TO_BODY = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  private static readonly ENU_TO_WORLD = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
  private m = new THREE.Matrix4();
  private sat = new THREE.Matrix4();
  private part = new THREE.Matrix4();
  private rot = new THREE.Matrix4();
  private v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  constructor(model: THREE.Object3D, private max = 26) {
    model.updateMatrixWorld(true);
    const take = (rootName: string, count: number): Part[] => {
      const root = model.getObjectByName(rootName);
      if (!root) return [];
      const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
      const out: Part[] = [];
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const mesh = new THREE.InstancedMesh(o.geometry, o.material, count);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(mesh);
        out.push({ mesh, local: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) });
      });
      return out;
    };
    this.bus = take('Bus', max);
    this.panel = take('SolarPanel', max * PANELS * 2);
    this.yoke = take('Yoke', max * 2);
  }

  /**
   * Each frame. payload: the snapshot's; cam: the camera's world position (the floating origin);
   * enuToWorld: pad ENU -> world (float64).
   */
  update(payload: Snapshot['payload'], cam: readonly number[], enuToWorld: (p: V3) => V3): void {
    const sats = payload?.sats ?? [];
    let n = 0;
    let np = 0;
    let ny = 0;
    for (const s of sats) {
      if (n >= this.max) break;
      const w = enuToWorld(s.pos);
      const dx = w[0] - cam[0], dy = w[1] - cam[1], dz = w[2] - cam[2];
      if (dx * dx + dy * dy + dz * dz > DRAW_RANGE * DRAW_RANGE) continue;
      // The satellite's frame in the world (camera-relative).
      this.rot.copy(StarlinkFleet.ENU_TO_WORLD).multiply(m3(s.rot, this.m)).multiply(StarlinkFleet.MODEL_TO_BODY);
      this.sat.copy(this.rot).setPosition(dx, dy, dz);
      for (const p of this.bus) p.mesh.setMatrixAt(n, this.part.multiplyMatrices(this.sat, p.local));
      n++;
      // Its wings, as far out as they've got.
      const a = (Math.PI / 2) * smooth(SWING[0], SWING[1], s.age);
      const g = (Math.PI / 2) * (1 - smooth(UNFOLD[0], UNFOLD[1], s.age));
      for (const side of [1, -1]) {
        np = this.wing(side, a, g, np);
        ny = this.yokeAt(side, a, ny);
      }
    }
    for (const p of this.bus) {
      p.mesh.count = n;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const p of this.panel) {
      p.mesh.count = np;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const p of this.yoke) {
      p.mesh.count = ny;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    this.group.visible = n > 0;
  }

  /**
   * A wing's frame (Blender axes): its hinge on the bus's long edge, u its way out (up off the
   * back while stowed, out sideways once swung), w across it (where the folded panels point).
   */
  private frame(side: number, a: number): { hinge: THREE.Vector3; u: THREE.Vector3; w: THREE.Vector3 } {
    const [hinge, u, w] = this.v;
    // (The other wing's stack rides on this one's, stowed.)
    const lift = side < 0 ? STACK_T * (1 - Math.sin(a)) : 0;
    hinge.set(0, side * (BUS_W / 2 + 0.05), BUS_T / 2 + 0.01 + lift);
    u.set(0, side * Math.sin(a), Math.cos(a));
    w.set(0, -side * Math.cos(a), Math.sin(a));
    return { hinge, u, w };
  }

  /** Place a template (Blender axes: x' = side X, y' = along, z' = x' x y') at `at`, in this satellite. */
  private place(parts: Part[], index: number, side: number, along: THREE.Vector3, at: THREE.Vector3, stretch = 1): void {
    const x = this.v[3].set(side, 0, 0);
    const z = this.v[4].crossVectors(x, along);
    // Blender -> model axes for each.
    const X = B(x.x, x.y, x.z, new THREE.Vector3());
    const Y = B(along.x, along.y, along.z, new THREE.Vector3()).multiplyScalar(stretch);
    const Z = B(z.x, z.y, z.z, new THREE.Vector3());
    // Template (Blender X, Y, Z) is model (X, Z, -Y): its columns in model axes.
    const p = B(at.x, at.y, at.z, new THREE.Vector3());
    this.m.makeBasis(X, Z, Y.clone().negate()).setPosition(p);
    this.part.multiplyMatrices(this.sat, this.m);
    for (const pt of parts) pt.mesh.setMatrixAt(index, this.m.clone().multiplyMatrices(this.part, pt.local));
  }

  private wing(side: number, a: number, g: number, index: number): number {
    const { hinge, u, w } = this.frame(side, a);
    const len = 0.05 + YOKE * Math.sin(a);
    const at = hinge.clone().addScaledVector(u, len);
    const d = new THREE.Vector3();
    for (let k = 0; k < PANELS; k++) {
      d.copy(u).multiplyScalar(Math.cos(g)).addScaledVector(w, (k % 2 === 0 ? 1 : -1) * Math.sin(g));
      this.place(this.panel, index++, side, d, at);
      at.addScaledVector(d, PANEL_W).addScaledVector(u, (PANEL_T + 0.003) * Math.sin(g));
    }
    return index;
  }

  private yokeAt(side: number, a: number, index: number): number {
    const { hinge, u } = this.frame(side, a);
    this.place(this.yoke, index, side, u.clone(), hinge.clone(), (0.05 + YOKE * Math.sin(a)) / YOKE);
    return index + 1;
  }
}

/** A row-major 3x3 as a Matrix4. */
function m3(r: M3, out: THREE.Matrix4): THREE.Matrix4 {
  return out.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
}

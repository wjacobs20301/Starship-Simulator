// Loads the Blender-built glTF models (see art/blender, `npm run models`).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';

/**
 * Levels of detail for the vehicle models' heavier meshes, made at load time: from `distance`
 * (m, camera to the vehicle) on, draw `geometry` (same vertices, fewer triangles) instead.
 * The source models are ~0.9 M triangles for a full stack: far more than a few hundred metres
 * away can show.
 */
export const DETAIL_LEVELS = new WeakMap<THREE.BufferGeometry, { distance: number; geometry: THREE.BufferGeometry }[]>();

/** Simplification steps: allowed geometric error (m) and from what distance it's used. */
// (Far enough that the error is a fraction of a pixel even on a Retina display: no visible change.)
const LOD_STEPS = [
  { distance: 800, error: 0.04 },
  { distance: 2500, error: 0.2 },
];

function buildDetailLevels(root: THREE.Object3D): void {
  const done = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry as THREE.BufferGeometry;
    if (done.has(g) || !g.index || g.index.count < 6000) return;
    done.add(g);
    const pos = g.attributes.position;
    const flat = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      flat[i * 3] = pos.getX(i);
      flat[i * 3 + 1] = pos.getY(i);
      flat[i * 3 + 2] = pos.getZ(i);
    }
    // Errors are relative to the mesh's size, in its own (possibly scaled) units.
    g.computeBoundingBox();
    const size = g.boundingBox!.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z) || 1;
    const scale = o.getWorldScale(new THREE.Vector3());
    const unitsPerMetre = 1 / Math.max(1e-6, Math.max(scale.x, scale.y, scale.z));
    const indices = new Uint32Array(g.index.array as ArrayLike<number>);
    const levels: { distance: number; geometry: THREE.BufferGeometry }[] = [];
    let last = indices.length;
    for (const step of LOD_STEPS) {
      const [out] = MeshoptSimplifier.simplify(indices, flat, 3, 0, (step.error * unitsPerMetre) / extent, ['LockBorder']);
      if (out.length > last * 0.7) continue; // not worth a level
      last = out.length;
      const lod = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(g.attributes)) lod.setAttribute(name, attr);
      lod.setIndex(new THREE.BufferAttribute(pos.count < 65536 ? new Uint16Array(out) : out, 1));
      lod.boundingSphere = g.boundingSphere;
      lod.boundingBox = g.boundingBox;
      levels.push({ distance: step.distance, geometry: lod });
    }
    if (levels.length) DETAIL_LEVELS.set(g, levels);
  });
}

export interface ModelLibrary {
  booster: THREE.Object3D;
  ship: THREE.Object3D;
  pad: THREE.Object3D;
}

const NAMES = ['booster', 'ship', 'pad'] as const;

export async function loadModels(
  renderer: THREE.WebGLRenderer,
  onProgress: (fraction: number) => void,
): Promise<ModelLibrary> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const progress = new Map<string, number>();
  const report = () => onProgress([...progress.values()].reduce((a, b) => a + b, 0) / NAMES.length);

  await MeshoptSimplifier.ready;
  const loaded = await Promise.all(
    NAMES.map((name) =>
      loader
        .loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`, (e) => {
          if (e.total) progress.set(name, e.loaded / e.total);
          report();
        })
        .then((gltf) => {
          progress.set(name, 1);
          report();
          gltf.scene.traverse((o) => {
            if (!(o instanceof THREE.Mesh)) return;
            o.castShadow = true;
            o.receiveShadow = true;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) {
                const tex = (m as THREE.MeshStandardMaterial)[key];
                if (tex) tex.anisotropy = anisotropy;
              }
            }
          });
          if (name !== 'pad') {
            gltf.scene.updateMatrixWorld(true);
            buildDetailLevels(gltf.scene);
          }
          return gltf.scene;
        }),
    ),
  );
  return { booster: loaded[0], ship: loaded[1], pad: loaded[2] };
}

/** A pivot node from the models: rotates about its local +Y (Blender's local Z hinge axis). */
export class Pivot {
  private base: THREE.Quaternion;
  private q = new THREE.Quaternion();
  private static readonly AXIS = new THREE.Vector3(0, 1, 0);

  constructor(readonly node: THREE.Object3D) {
    this.base = node.quaternion.clone();
  }

  set angle(rad: number) {
    this.node.quaternion.copy(this.base).multiply(this.q.setFromAxisAngle(Pivot.AXIS, rad));
  }

  /** Hinge angle plus an extra rotation after it (e.g. a wrecked arm sagging off its hinge). */
  pose(rad: number, extra: THREE.Quaternion): void {
    this.node.quaternion.copy(this.base).multiply(this.q.setFromAxisAngle(Pivot.AXIS, rad)).multiply(extra);
  }
}

export function findPivot(root: THREE.Object3D, name: string): Pivot {
  const node = root.getObjectByName(name);
  if (!node) throw new Error(`model node "${name}" not found`);
  return new Pivot(node);
}

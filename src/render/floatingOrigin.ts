// Floating origin. World positions are kept in float64 (JS numbers) in the pad's
// frame; before each frame, the camera's world position is subtracted so everything
// the GPU sees (float32) is small and precise near the camera. Without this, meshes
// visibly jitter a few km from the origin.
//
// Axis convention (three.js world): x = East, y = Up, z = -North.

import * as THREE from 'three';
import type { M3, V3 } from '../sim/math';

export const enuToWorld = (p: V3): V3 => [p[0], p[2], -p[1]];

/** Mesh-local axes: +Y = body +x (nose), +X = body +y, -Z = body +z. */
const MESH_TO_BODY = new THREE.Matrix4().set(0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);
const ENU_TO_WORLD = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** Orientation of a vehicle mesh from its body -> ENU rotation matrix. */
export function vehicleQuaternion(rot: M3, out = new THREE.Quaternion()): THREE.Quaternion {
  const r = new THREE.Matrix4().set(rot[0], rot[1], rot[2], 0, rot[3], rot[4], rot[5], 0, rot[6], rot[7], rot[8], 0, 0, 0, 0, 1);
  const m = new THREE.Matrix4().multiplyMatrices(ENU_TO_WORLD, r).multiply(MESH_TO_BODY);
  return out.setFromRotationMatrix(m);
}

export class FloatingOrigin {
  /** Camera world position, float64. */
  camera: V3 = [0, 0, 0];

  /** Position an object whose float64 world position is stored in userData.world. */
  place(obj: THREE.Object3D, world: V3): void {
    obj.userData.world = world;
    obj.position.set(world[0] - this.camera[0], world[1] - this.camera[1], world[2] - this.camera[2]);
  }

  /** Re-place every object registered with a static world position. */
  apply(objects: Iterable<THREE.Object3D>): void {
    for (const o of objects) this.place(o, o.userData.world as V3);
  }
}

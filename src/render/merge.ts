// Draw-call reduction: many small static meshes (built from boxes and cylinders) merged into one
// mesh per material. Each draw call costs CPU time; the triangles are the same.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Merge the meshes under `group` (not those in `keep`, which move on their own) into one mesh
 * per material, in `group`'s frame. The originals are removed.
 */
export function mergeStatic(group: THREE.Object3D, keep: Set<THREE.Object3D> = new Set()): void {
  group.updateMatrixWorld(true);
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMaterial = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean }>();
  const merged: THREE.Mesh[] = [];
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || keep.has(o) || Array.isArray(o.material)) return;
    let g = (o.geometry as THREE.BufferGeometry).clone();
    // (Only the attributes every primitive has, and all non-indexed, so they can be joined.)
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    // (And all plain floats: a model's compressed attributes (normalized integers) won't join
    // with a box's, and the merge failed, taking every part of that material with it.)
    for (const name of Object.keys(g.attributes)) g.setAttribute(name, plain(g.attributes[name]));
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toGroup, o.matrixWorld));
    let entry = byMaterial.get(o.material);
    if (!entry) byMaterial.set(o.material, (entry = { geos: [], cast: false, receive: false }));
    entry.geos.push(g);
    entry.cast ||= o.castShadow;
    entry.receive ||= o.receiveShadow;
    merged.push(o);
  });
  for (const o of merged) o.removeFromParent();
  for (const [material, { geos, cast, receive }] of byMaterial) {
    const geometry = mergeGeometries(geos);
    // (Couldn't be joined after all: each part drawn on its own, as it was, rather than not at all.)
    const parts = geometry ? [geometry] : geos;
    if (geometry) for (const g of geos) g.dispose();
    for (const part of parts) {
      const mesh = new THREE.Mesh(part, material);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      group.add(mesh);
    }
  }
}

/** An attribute as plain 32-bit floats (its values as the shader would see them). */
function plain(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
  if (a instanceof THREE.BufferAttribute && a.array instanceof Float32Array && !a.normalized) return a;
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, a.itemSize);
}

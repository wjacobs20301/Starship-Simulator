// The rocket garden by the Mega Bays: retired vehicles standing on display (B12 and S20 in
// OpenStreetMap). They're the real booster and ship models (the flight vehicles' shapes and
// materials, shared), at a coarse detail level: they're usually seen from kilometres away.
//
// They never move, so they're merged: one mesh per material for the whole garden (a few draw
// calls, not one per engine bell, fin and pipe of every vehicle: ~200 a frame).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DETAIL_LEVELS, type ModelLibrary } from './models';

export interface GardenVehicle {
  kind: 'booster' | 'ship';
  /** Base position in render world (pad-local: x = E, y = U, z = -N), m. */
  pos: [number, number, number];
}

/** A copy of `g` with only the vertices its index uses (a coarse level shares the full model's), moved by `m`. */
function compact(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const index = g.index;
  if (!index) {
    const c = g.clone();
    c.applyMatrix4(m);
    return c;
  }
  const remap = new Map<number, number>();
  const idx = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) {
    const v = index.getX(i);
    let n = remap.get(v);
    if (n === undefined) {
      n = remap.size;
      remap.set(v, n);
    }
    idx[i] = n;
  }
  for (const [name, attr] of Object.entries(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const arr = new Float32Array(remap.size * a.itemSize);
    for (const [from, to] of remap) for (let k = 0; k < a.itemSize; k++) arr[to * a.itemSize + k] = a.getComponent(from, k);
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.applyMatrix4(m);
  return out;
}

export function rocketGarden(lib: ModelLibrary, vehicles: GardenVehicle[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Rocket garden';
  // Every part of every vehicle, at its coarsest, in the garden's frame, by material (and by
  // which attributes it has: only like ones merge).
  const buckets = new Map<string, { material: THREE.Material; parts: THREE.BufferGeometry[] }>();
  for (const v of vehicles) {
    const model = (v.kind === 'booster' ? lib.booster : lib.ship).clone(true);
    model.position.set(...v.pos);
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.visible) return;
      const levels = DETAIL_LEVELS.get(o.geometry);
      // (The coarsest level that's still well under a pixel from the pad, a few km off.)
      const level = levels?.filter((l) => l.error <= 0.35).pop();
      const g = level ? level.geometry : (o.geometry as THREE.BufferGeometry);
      const material = o.material as THREE.Material;
      if (Array.isArray(o.material)) return;
      const part = compact(g, o.matrixWorld);
      const key = `${material.uuid}|${Object.keys(part.attributes).sort().join(',')}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { material, parts: [] }));
      b.parts.push(part);
    });
  }
  for (const { material, parts } of buckets.values()) {
    const merged = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// Starbase buildings and tanks from OpenStreetMap (public/terrain/facilities.json, built by
// scripts/terrain/build-tiles.ts): extruded footprints and cylinders on top of the imagery,
// merged into one mesh per material. Positions are local east/north metres from the pad; the
// Earth's curvature drop is applied so distant buildings sit on the curved terrain.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PAD } from '../sim/constants';
import { TRENCHES, insideTrench } from './launchSite';

interface Facility {
  kind: 'building' | 'vtank' | 'htank';
  name?: string;
  ring?: number[][];
  center: number[];
  base: number;
  height: number;
  diameter?: number;
  length?: number;
  angle?: number;
  material: 'industrial' | 'bay' | 'house' | 'tank' | 'rocket';
}

const R_EARTH = 6371000;
/** Local (east, north, up) -> render world (x = E, y = U, z = -N). */
const ENU_TO_WORLD = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

const MATERIALS: Record<Facility['material'], THREE.MeshStandardMaterial> = {
  industrial: new THREE.MeshStandardMaterial({ color: 0xb9bcbf, metalness: 0.35, roughness: 0.6 }),
  bay: new THREE.MeshStandardMaterial({ color: 0xe4e6e8, metalness: 0.2, roughness: 0.55 }),
  house: new THREE.MeshStandardMaterial({ color: 0xd8cfbf, metalness: 0.0, roughness: 0.85 }),
  tank: new THREE.MeshStandardMaterial({ color: 0xeef0f2, metalness: 0.45, roughness: 0.35 }),
  rocket: new THREE.MeshStandardMaterial({ color: 0xd0d3d7, metalness: 1.0, roughness: 0.3 }),
};

export async function loadFacilities(): Promise<THREE.Group> {
  const res = await fetch(`${import.meta.env.BASE_URL}terrain/facilities.json`);
  const { facilities } = (await res.json()) as { facilities: Facility[] };
  const byMat = new Map<Facility['material'], THREE.BufferGeometry[]>();
  const push = (m: Facility['material'], g: THREE.BufferGeometry) => {
    if (!byMat.has(m)) byMat.set(m, []);
    byMat.get(m)!.push(g.index ? g.toNonIndexed() : g);
  };

  for (const f of facilities) {
    const [e, n] = f.center;
    // The V3 flame trenches and launch mounts are part of the pad model (OSM maps them as buildings).
    if (TRENCHES.some((t) => insideTrench(t, e, n))) continue;
    // Ground in render space: terrain height above the pad ground, minus curvature drop.
    const y0 = f.base - PAD.groundAlt - (e * e + n * n) / (2 * R_EARTH);
    let g: THREE.BufferGeometry;
    if (f.kind === 'building' && f.ring) {
      const shape = new THREE.Shape(f.ring.map(([x, y]) => new THREE.Vector2(x - e, y - n)));
      // Extrude along +Z (up in local ENU), sinking 1 m into the ground to hide terrain gaps.
      g = new THREE.ExtrudeGeometry(shape, { depth: f.height + 1, bevelEnabled: false });
      g.translate(0, 0, -1);
      g.applyMatrix4(ENU_TO_WORLD);
    } else if (f.kind === 'vtank') {
      const r = f.diameter! / 2;
      g = new THREE.CylinderGeometry(r, r, f.height + 1, 24);
      g.translate(0, (f.height + 1) / 2 - 1, 0);
      // Domed top.
      const dome = new THREE.SphereGeometry(r, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.scale(1, 0.35, 1);
      dome.translate(0, f.height, 0);
      g = mergeGeometries([g.toNonIndexed(), dome.toNonIndexed()])!;
    } else {
      const r = f.diameter! / 2;
      g = new THREE.CapsuleGeometry(r, Math.max(0.1, f.length! - 2 * r), 6, 16);
      // Capsule is along Y: lay it along the footprint's long axis (angle from east).
      g.rotateZ(Math.PI / 2);
      g.rotateY(f.angle!);
      g.translate(0, r + 0.6, 0);
    }
    g.translate(e, y0, -n);
    push(f.material, g);
  }

  const group = new THREE.Group();
  group.name = 'Facilities';
  for (const [m, geos] of byMat) {
    const merged = mergeGeometries(geos)!;
    merged.computeVertexNormals();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, MATERIALS[m]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `facilities ${m}`;
    group.add(mesh);
  }
  return group;
}

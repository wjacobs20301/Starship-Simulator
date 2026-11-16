// The transport stand beside each launch mount (sim/padCollision.ts STANDS): where the arms,
// swung to the side, set a ship or a booster down, and take one from. A ring the vehicle's
// skirt sits on, 3 m up on a braced steel frame, carried on two self-propelled trailers (the
// many-wheeled SPMTs every Starship rides between the production site and the pad).
//
// Drawn from the published photos of them in general terms (a ring on a square frame on two
// rows of axles, blue-grey): approximate, not surveyed.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STANDS, STAND_HEIGHT } from '../sim/padCollision';
import { SLAB_TOP } from './launchSite';

/** A trailer: its length, width, deck height, and its axle lines. */
const TRAILER = { length: 15.6, width: 2.6, deck: 1.5, axles: 9, apart: 4.6 };
const RING_R = 4.5;
/** The ring's top above the slab the trailers stand on, m (the physics has it STAND_HEIGHT above the pad's ground, the slab SLAB_TOP). */
export const STAND_TOP = STAND_HEIGHT - SLAB_TOP;

const WHITE = new THREE.Color(0xd9dad6);
const TYRE = new THREE.Color(0x1c1d1f);
const STEEL = new THREE.Color(0x6f86a0);
const YELLOW = new THREE.Color(0xc9a227);

function tinted(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const n = ng.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.deleteAttribute('uv');
  return ng;
}

/** A square bar from one point to another. */
function bar(p: THREE.Vector3, q: THREE.Vector3, size: number, c: THREE.Color): THREE.BufferGeometry {
  const len = p.distanceTo(q);
  const g = new THREE.BoxGeometry(size, len, size);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), q.clone().sub(p).normalize()));
  g.translate((p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2);
  return tinted(g, c);
}

/** One stand, in its own frame: x along the trailers, y up from the ground, z across them. */
function stand(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const steel = STEEL;
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: THREE.Color) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    parts.push(tinted(g, c));
  };
  for (const side of [-1, 1]) {
    const z = (side * TRAILER.apart) / 2;
    // The trailer's deck, its power pack at one end, a yellow marker rail along its edge.
    box(0, TRAILER.deck - 0.35, z, TRAILER.length, 0.7, TRAILER.width, WHITE);
    box(-TRAILER.length / 2 - 1.3, TRAILER.deck - 0.1, z, 2.4, 1.4, 2.2, WHITE);
    box(0, TRAILER.deck - 0.62, z + side * (TRAILER.width / 2 + 0.02), TRAILER.length, 0.14, 0.05, YELLOW);
    // Its axle lines: a pair of twin wheels each.
    for (let k = 0; k < TRAILER.axles; k++) {
      const x = -TRAILER.length / 2 + ((k + 0.5) * TRAILER.length) / TRAILER.axles;
      for (const w of [-0.75, 0.75]) {
        const tyre = new THREE.CylinderGeometry(0.52, 0.52, 0.62, 14);
        tyre.rotateX(Math.PI / 2);
        tyre.translate(x, 0.52, z + w);
        parts.push(tinted(tyre, TYRE));
      }
    }
  }
  // The frame on the decks: two beams across the trailers, two along them, a post under the ring
  // at each of eight points, braced to its neighbours, and the ring itself.
  const base = TRAILER.deck;
  for (const x of [-3.6, 3.6]) box(x, base + 0.25, 0, 0.5, 0.5, TRAILER.apart + TRAILER.width, steel);
  for (const z of [-3.6, 3.6]) box(0, base + 0.25, z, 9, 0.5, 0.5, steel);
  const top = STAND_TOP - 0.5;
  const at = (k: number, y: number, r = RING_R) => new THREE.Vector3(Math.cos((k / 8) * Math.PI * 2 + Math.PI / 8) * r, y, Math.sin((k / 8) * Math.PI * 2 + Math.PI / 8) * r);
  for (let k = 0; k < 8; k++) {
    parts.push(bar(at(k, base + 0.5), at(k, top), 0.34, steel));
    parts.push(bar(at(k, base + 0.5), at(k + 1, top), 0.16, steel));
  }
  const ring = new THREE.TorusGeometry(RING_R, 0.26, 8, 48);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, STAND_TOP - 0.26, 0);
  parts.push(tinted(ring, steel));
  const inner = new THREE.TorusGeometry(RING_R - 0.9, 0.12, 6, 40);
  inner.rotateX(Math.PI / 2);
  inner.translate(0, top, 0);
  parts.push(tinted(inner, steel));
  // The blocks a booster's hold-down points seat on, round the ring (twenty, as on the mount).
  {
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      const g = new THREE.BoxGeometry(0.5, 0.34, 0.7);
      g.rotateY(-a);
      g.translate(Math.cos(a) * (RING_R + 0.35), STAND_TOP - 0.3, Math.sin(a) * (RING_R + 0.35));
      parts.push(tinted(g, WHITE));
    }
  }
  return parts;
}

/**
 * The stands: one waiting beside each mount, and one that travels (a rollout: sim/rollout.ts),
 * carrying its vehicle from the Starfactory to the pad, where it is that pad's stand from then on.
 */
export class TransportStands {
  /** The waiting stands (pad-local: placed with the launch site). */
  readonly group = new THREE.Group();
  /** The travelling one (placed by itself each frame; hidden when there's no rollout). */
  readonly rolling: THREE.Mesh;
  private waiting: THREE.Mesh[] = [];

  constructor() {
    this.group.name = 'Transport stands';
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.35 });
    const make = (place: (g: THREE.BufferGeometry) => void) => {
      const parts = stand();
      parts.forEach(place);
      const merged = mergeGeometries(parts)!;
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };
    for (const s of STANDS) {
      // (Render world: x east, z south; its trailers along the trench.)
      const mesh = make((g) => {
        g.rotateY(s.yaw);
        g.translate(s.at[0], SLAB_TOP, -s.at[1]);
      });
      mesh.name = `Stand ${s.pad + 1}`;
      this.waiting[s.pad] = mesh;
      this.group.add(mesh);
    }
    this.rolling = make(() => {});
    this.rolling.name = 'Transport';
    this.rolling.visible = false;
  }

  /**
   * Each frame. transport: the rollout's, from the snapshot (null: none); at: where it is drawn
   * (render world, float64: under the vehicle it carries, as that is drawn this frame, its
   * wheels on the ground there); place: the floating origin's.
   */
  update(transport: { pad: number; heading: number } | null | undefined, at: [number, number, number] | null, place: (o: THREE.Object3D, world: [number, number, number]) => void): void {
    this.waiting.forEach((m, pad) => (m.visible = !transport || transport.pad !== pad));
    this.rolling.visible = !!transport && !!at;
    if (!transport || !at) return;
    this.rolling.rotation.y = transport.heading;
    place(this.rolling, at);
  }
}

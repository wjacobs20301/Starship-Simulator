// The gaps in the ship's heat shield (sim/heatShield.ts), drawn on its belly: where tiles are
// missing, the pale backing shows through the black hexagons, and in the entry those spots glow
// hot (then char brown, or burn through white-hot).
//
// Each patch of the sim's grid holds ~28 tiles; its missing ones are placed as a cluster round a
// spot in the patch (the same spot every time: hashed from the patch), one small hexagon each.

import * as THREE from 'three';
import { BOOSTER_LENGTH } from '../sim/config/starshipV3';
import { SHIELD, type ShieldSnapshot } from '../sim/heatShield';
import { toFxLayer } from './atmosphere';

/** A hexagon tile, across its flats ~0.31 m. */
const TILE_R = 0.18;
/** Tiles per patch along the ship and round it. */
const GRID_U = 7;
const GRID_V = 4;
/** Most gaps drawn. */
const MAX = 2400;

/** The hull's radius at a height above the ship's base (m): the barrel, then the nose's taper. */
function hullRadius(x: number): number {
  const r = 4.5;
  if (x <= 38) return r;
  const t = Math.min(1, (x - 38) / (52.1 - 38));
  return Math.max(0.6, r * Math.pow(1 - t * t, 0.62));
}

/** A small hash for where a patch's gap sits. */
function hash(i: number): number {
  let h = Math.imul(i ^ 0x2c1b3c6d, 0x297a2d39);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export class TileGaps {
  readonly group = new THREE.Group();
  private base: THREE.InstancedMesh;
  private glow: THREE.InstancedMesh;
  /** Which patch each drawn gap belongs to. */
  private owner: number[] = [];
  private key = '';
  private color = new THREE.Color();
  private static readonly BACKING = new THREE.Color(0.78, 0.76, 0.72);
  private static readonly CHAR = new THREE.Color(0.22, 0.14, 0.09);

  constructor() {
    const hex = new THREE.CircleGeometry(TILE_R, 6);
    // (Flat in its own XY plane, facing +Z: placed tangent to the hull below.)
    this.base = new THREE.InstancedMesh(hex, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 }), MAX);
    this.base.count = 0;
    this.base.frustumCulled = false;
    this.base.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.glow = new THREE.InstancedMesh(
      hex,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      MAX,
    );
    this.glow.count = 0;
    this.glow.frustumCulled = false;
    this.glow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.group.add(this.base, this.glow);
    toFxLayer(this.glow);
  }

  /** Each frame: the shield's state (gaps, char, glow now). */
  update(s: ShieldSnapshot): void {
    // (Re-placed only when the gaps change.)
    const key = s.missing.join(',');
    if (key !== this.key) {
      this.key = key;
      this.place(s.missing);
    }
    const n = this.owner.length;
    if (!n) return;
    for (let k = 0; k < n; k++) {
      const i = this.owner[k];
      const char = Math.min(1, s.char[i]);
      // The backing, browning as it chars.
      this.color.copy(TileGaps.BACKING).lerp(TileGaps.CHAR, char);
      this.base.setColorAt(k, this.color);
      // The glow: with the flux on it now (W/m^2; a nominal entry peaks near 4e5 down the middle),
      // white-hot where it has burned through.
      const hot = Math.min(1.6, s.glow[i] / 2.5e5) * (s.char[i] >= 1 ? 1.8 : 1);
      this.color.setRGB(1.0 * hot, 0.42 * hot * hot, 0.12 * hot * hot * hot);
      this.glow.setColorAt(k, this.color);
    }
    this.base.instanceColor!.needsUpdate = true;
    this.glow.instanceColor!.needsUpdate = true;
  }

  private place(missing: number[]): void {
    this.owner = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const normal = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    const one = new THREE.Vector3(1, 1, 1);
    let k = 0;
    for (let i = 0; i < missing.length && k < MAX; i++) {
      const count = missing[i];
      if (!count) continue;
      const row = Math.floor(i / SHIELD.cols);
      const col = i % SHIELD.cols;
      // The tiles of this patch, nearest the gap's centre first.
      const cu = hash(i) * GRID_U;
      const cv = hash(i + 7919) * GRID_V;
      const cells: [number, number, number][] = [];
      for (let u = 0; u < GRID_U; u++) for (let v = 0; v < GRID_V; v++) cells.push([u, v, Math.hypot(u + 0.5 - cu, (v + 0.5 - cv) * 1.15)]);
      cells.sort((a, b) => a[2] - b[2]);
      for (let c = 0; c < Math.min(count, cells.length) && k < MAX; c++) {
        const [u, v] = cells[c];
        // (Hexagon rows staggered half a tile.)
        const x = SHIELD.x0 + row * SHIELD.rowLen + ((u + 0.5 + (v % 2) * 0.5) / (GRID_U + 0.5)) * SHIELD.rowLen;
        const angle = (((col + (v + 0.5) / GRID_V) - SHIELD.cols / 2) * SHIELD.colDeg * Math.PI) / 180;
        const r = hullRadius(x) + 0.07;
        // Mesh axes: +Y up the ship (body x), +X the belly (body +y), -Z body +z.
        normal.set(Math.cos(angle), 0, -Math.sin(angle));
        pos.set(r * Math.cos(angle), BOOSTER_LENGTH + x, -r * Math.sin(angle));
        q.setFromUnitVectors(Z, normal);
        m.compose(pos, q, one);
        this.base.setMatrixAt(k, m);
        // (The glow a hair further out, over the backing.)
        pos.addScaledVector(normal, 0.01);
        m.compose(pos, q, one);
        this.glow.setMatrixAt(k, m);
        this.owner.push(i);
        k++;
      }
    }
    this.base.count = this.glow.count = k;
    this.base.instanceMatrix.needsUpdate = true;
    this.glow.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.base.geometry.dispose();
    (this.base.material as THREE.Material).dispose();
    (this.glow.material as THREE.Material).dispose();
  }
}

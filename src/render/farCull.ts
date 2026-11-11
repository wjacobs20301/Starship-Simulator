// Leaving out what's too small to see: the launch site's thousands of parts (the pad, the
// buildings, the rocket garden, South Padre's skyline) are drawn whatever the distance, and from
// tens of km off, or from orbit, most are well under a pixel: hundreds of draw calls and a
// million or more triangles a frame for nothing. Each static part is skipped while its bounding
// sphere is under about a pixel across on screen.
//
// Skipped by taking it off every layer (not by `visible`, which the pad's rig sets for its moving
// and wrecked parts): the atmosphere pass sorts what's on layer 0 into its passes each frame, and
// the shadow camera draws layer 0, so a part off it is in neither.

import * as THREE from 'three';
import type { V3 } from '../sim/math';

interface Item {
  obj: THREE.Object3D;
  /** Its bounding sphere: centre (world, float64) and radius, m. */
  c: V3;
  r: number;
  /** Its layers while shown. */
  mask: number;
  hidden: boolean;
}

/** Hidden under this many pixels across, shown again over the second (no flicker at the edge). */
const HIDE_PX = 1.2;
const SHOW_PX = 1.6;

export class FarCull {
  private items: Item[] = [];
  private sphere = new THREE.Sphere();

  /** Count in the meshes under `root` (placed now, static: their world positions from here on). cam: the camera (world, float64). */
  add(root: THREE.Object3D, cam: V3): void {
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !(m.layers.mask & 1)) return;
      const g = m.geometry;
      if ((m as THREE.InstancedMesh).isInstancedMesh) {
        const im = m as THREE.InstancedMesh;
        if (!im.boundingSphere) im.computeBoundingSphere();
        this.sphere.copy(im.boundingSphere!);
      } else {
        if (!g.boundingSphere) g.computeBoundingSphere();
        this.sphere.copy(g.boundingSphere!);
      }
      this.sphere.applyMatrix4(m.matrixWorld);
      this.items.push({
        obj: m,
        c: [this.sphere.center.x + cam[0], this.sphere.center.y + cam[1], this.sphere.center.z + cam[2]],
        r: this.sphere.radius,
        mask: m.layers.mask,
        hidden: false,
      });
    });
  }

  /** Per frame. cam: the camera (world, float64); pxPerRad: screen pixels per radian of view. */
  update(cam: V3, pxPerRad: number): void {
    for (const it of this.items) {
      const d = Math.hypot(it.c[0] - cam[0], it.c[1] - cam[1], it.c[2] - cam[2]);
      const px = d > it.r ? ((2 * it.r) / d) * pxPerRad : Infinity;
      if (!it.hidden && px < HIDE_PX) {
        it.hidden = true;
        it.mask = it.obj.layers.mask;
        it.obj.layers.mask = 0;
      } else if (it.hidden && px > SHOW_PX) {
        it.hidden = false;
        it.obj.layers.mask = it.mask;
      }
    }
  }

  /** How many parts are skipped now (for the debug console). */
  get skipped(): number {
    return this.items.reduce((n, it) => n + (it.hidden ? 1 : 0), 0);
  }

  get size(): number {
    return this.items.length;
  }
}

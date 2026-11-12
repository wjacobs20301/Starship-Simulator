// Night lighting and the shadow map: where the shadows cover (the launch site, or the ground under
// a climbing vehicle), and whether the map needs drawing again. (Moved out of main.ts: its
// SHADOW_CEILING, siteShadowArea, shadowKey / shadowAt and the frame step shadowStep.)

import * as THREE from 'three';
import type { V3 } from '../sim/math';
import { MOUNTS, TOWERS } from '../sim/padCollision';
import type { Snapshot } from '../sim/simulation';
import type { CameraTarget } from './cameras';
import { setBuildingNight } from './facilities';
import type { FxVehicle } from './fx/launchFx';
import type { PadLights } from './padLights';
import type { World } from './scene';

export interface ShadowsDeps {
  world: World;
  padLights: PadLights;
  /** How many vehicle meshes there are, and whether the pad's tower rig is in (both shape the shadows). */
  meshCount(): number;
  padRigIn(): boolean;
}

export interface Shadows {
  /** Night lighting, and the shadow map: where it covers, and whether it needs drawing again. */
  shadowStep(snap: Snapshot, placements: FxVehicle[], target: CameraTarget | null, cam: V3, dayAngle: number, now: number): void;
}

export function createShadows(deps: ShadowsDeps): Shadows {
  const { world, padLights } = deps;
  const shadowFocus = new THREE.Vector3();
  /** Below this height (m) a vehicle's shadow on the ground is drawn. */
  const SHADOW_CEILING = 5000;
  /** The launch site's shadows: both towers, and the ground their shadows reach (world, m). */
  let siteShadow: { x: number; z: number; r: number } | null = null;
  const siteShadowArea = (sd: THREE.Vector3) => {
    if (siteShadow) return siteShadow;
    // Tower bases and where their tops' shadows land (the towers are ~145 m tall).
    const pts: [number, number][] = [];
    for (const [e, n] of [...TOWERS, ...MOUNTS]) {
      pts.push([e, -n], [e - (sd.x * 150) / sd.y, -n - (sd.z * 150) / sd.y]);
    }
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const z = (Math.min(...zs) + Math.max(...zs)) / 2;
    const r = Math.max(...pts.map(([px, pz]) => Math.hypot(px - x, pz - z))) + 40;
    siteShadow = { x, z, r };
    return siteShadow;
  };

  /** What the shadows depend on, coarsely: when it changes, the shadow map is redrawn. */
  let shadowKey = 0;
  let shadowAt = 0;

  function shadowStep(snap: Snapshot, placements: FxVehicle[], target: CameraTarget | null, cam: V3, dayAngle: number, now: number): void {
    // Shadows: near the ground they cover the whole launch site (both towers and the shadows they
    // cast) and, as a vehicle climbs, the ground its own shadow falls on, straight down the sun's
    // rays from it. Up high only the vehicle itself (its parts shading each other).
    const focus = target?.center ?? [0, 60, 0];
    const sd = world.sunDir;
    setBuildingNight(sd.y);
    padLights.update(now / 1000, world.renderer, world.camera);
    const fh = Math.max(0, focus[1]);
    if (fh < SHADOW_CEILING && sd.y > 0.08) {
      const gx = focus[0] - (sd.x * fh) / sd.y;
      const gz = focus[2] - (sd.z * fh) / sd.y;
      const site = siteShadowArea(sd);
      const d = Math.hypot(gx - site.x, gz - site.z);
      const reach = fh / sd.y;
      if (d < site.r + 400) {
        shadowFocus.set(site.x - cam[0], -cam[1], site.z - cam[2]);
        world.updateShadow(shadowFocus, Math.max(site.r, d + 80), reach);
      } else {
        shadowFocus.set(gx - cam[0], -cam[1], gz - cam[2]);
        world.updateShadow(shadowFocus, 160, reach);
      }
    } else {
      shadowFocus.set(focus[0] - cam[0], focus[1] - cam[1], focus[2] - cam[2]);
      world.updateShadow(shadowFocus, 140);
    }
    // (A hash of it all, to 5 cm and a fraction of a degree: no strings built every frame.)
    let key = 2166136261;
    const mixIn = (x: number) => {
      key = Math.imul(key ^ Math.round(x), 16777619);
    };
    for (const x of focus) mixIn(x * 20);
    mixIn(dayAngle * 2000);
    mixIn(deps.meshCount() * 2 + (deps.padRigIn() ? 1 : 0));
    for (const tw of snap.towers) {
      mixIn(tw.top * 20);
      mixIn(tw.angle * 20);
      mixIn(tw.slew * 20);
      mixIn(tw.qd * 20);
      mixIn((tw.down ? 1 : 0) + (tw.broken.L ? 2 : 0) + (tw.broken.R ? 4 : 0) + (tw.qdBroken ? 8 : 0));
    }
    for (const pl of placements) {
      for (const x of pl.world) mixIn(x * 20);
      const q = pl.mesh.root.quaternion;
      mixIn(q.x * 1000);
      mixIn(q.y * 1000);
      mixIn(q.z * 1000);
    }
    if (key !== shadowKey || now - shadowAt > 2000) {
      shadowKey = key;
      shadowAt = now;
      world.shadowsDirty();
    }
  }

  return { shadowStep };
}

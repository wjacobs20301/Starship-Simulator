// Camera rig. All positions are float64 world coordinates (x = E, y = U, z = -N).

import * as THREE from 'three';
import type { V3 } from '../sim/math';
import { enuToWorld } from './floatingOrigin';
import { ecefToWorld, worldToGeodetic } from './geo';

const EARTH_CENTER = ecefToWorld([0, 0, 0]);
const Y = new THREE.Vector3(0, 1, 0);
/** Earth-fixed axes in world coordinates (for the map camera). */
const axisWorld = (p: V3) => {
  const w = ecefToWorld(p);
  return new THREE.Vector3(w[0] - EARTH_CENTER[0], w[1] - EARTH_CENTER[1], w[2] - EARTH_CENTER[2]).normalize();
};
const EX = axisWorld([1e6, 0, 0]);
const EY = axisWorld([0, 1e6, 0]);
const EZ = axisWorld([0, 0, 1e6]);
/** Map camera distance from the Earth's centre, m. */
const MAP_MIN = 7.4e6;
/** (Out far enough to see the Moon's orbit.) */
const MAP_MAX = 1.2e9;
/** Closest the camera may come to the ground or sea, m. */
const GROUND_CLEARANCE = 2;

export type CameraMode = 'orbit' | 'chase' | 'pad' | 'spectator';
export const CAMERA_MODES: CameraMode[] = ['orbit', 'chase', 'pad', 'spectator'];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  orbit: 'Orbit (drag / scroll)',
  chase: 'Chase',
  pad: 'Pad camera',
  spectator: 'South Padre Island (~9 km)',
};

// Fixed viewpoints in pad ENU (m).
const PAD_CAM: V3 = enuToWorld([-300, -330, 2]);
/** Isla Blanca Park, South Padre Island: the classic public viewing spot, ~8 km north. */
const SPECTATOR_CAM: V3 = enuToWorld([150, 8150, 3]);

export interface CameraTarget {
  /** Point to look at (vehicle mid-body), world. */
  center: V3;
  /** Vehicle nose direction, world (unit). */
  axis: V3;
  /** Rough vehicle length, m. */
  size: number;
}

export class CameraRig {
  mode: CameraMode = 'orbit';
  azimuth = -2.3;
  elevation = 0.12;
  distance = 420;
  private dragging = false;
  private last = { x: 0, y: 0 };
  /** Local vertical at the target, and the rotation taking the pad's axes to local axes. */
  private up = new THREE.Vector3(0, 1, 0);
  private local = new THREE.Quaternion();
  /** Map view: orbiting the Earth's centre in the Earth-fixed frame (longitude / latitude). */
  map = false;
  mapLon = 0;
  mapLat = 0.4;
  mapDistance = 2.2e7;
  /** Ground height (m above the ellipsoid) at a lat / lon, where known (the streamed terrain). */
  groundHeight: (lat: number, lon: number) => number | null = () => null;

  constructor(el: HTMLElement) {
    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointerup', () => (this.dragging = false));
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      if (this.map) {
        const k = 0.004 * Math.min(1, (this.mapDistance - 6.2e6) / 1.2e7 + 0.15);
        this.mapLon -= (e.clientX - this.last.x) * k;
        this.mapLat = THREE.MathUtils.clamp(this.mapLat + (e.clientY - this.last.y) * k, -1.5, 1.5);
        this.last = { x: e.clientX, y: e.clientY };
        return;
      }
      if (this.mode !== 'orbit') this.mode = 'orbit';
      this.azimuth -= (e.clientX - this.last.x) * 0.005;
      this.elevation = THREE.MathUtils.clamp(this.elevation + (e.clientY - this.last.y) * 0.005, -1.4, 1.5);
      this.last = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.map) {
          this.mapDistance = THREE.MathUtils.clamp(this.mapDistance * Math.exp(e.deltaY * 0.001), MAP_MIN, MAP_MAX);
          return;
        }
        this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(e.deltaY * 0.001), 20, 2e6);
      },
      { passive: false },
    );
  }

  /** Toggle the map view, starting it over a point (world) such as the tracked vehicle. */
  toggleMap(over: V3): void {
    this.map = !this.map;
    if (!this.map) return;
    const d = new THREE.Vector3(over[0] - EARTH_CENTER[0], over[1] - EARTH_CENTER[1], over[2] - EARTH_CENTER[2]).normalize();
    this.mapLon = Math.atan2(d.dot(EY), d.dot(EX));
    this.mapLat = THREE.MathUtils.clamp(Math.asin(d.dot(EZ)) - 0.25, -1.4, 1.4);
  }

  /** The map camera: world position, looking at the Earth's centre with the north pole up. */
  private updateMap(camera: THREE.PerspectiveCamera): V3 {
    const cl = Math.cos(this.mapLat);
    const dir = new THREE.Vector3()
      .addScaledVector(EX, cl * Math.cos(this.mapLon))
      .addScaledVector(EY, cl * Math.sin(this.mapLon))
      .addScaledVector(EZ, Math.sin(this.mapLat));
    const pos: V3 = [
      EARTH_CENTER[0] + dir.x * this.mapDistance,
      EARTH_CENTER[1] + dir.y * this.mapDistance,
      EARTH_CENTER[2] + dir.z * this.mapDistance,
    ];
    if (camera.fov !== 40) {
      camera.fov = 40;
      camera.updateProjectionMatrix();
    }
    camera.position.set(0, 0, 0);
    camera.up.copy(EZ);
    camera.lookAt(-dir.x * this.mapDistance, -dir.y * this.mapDistance, -dir.z * this.mapDistance);
    return pos;
  }

  /** Keep a camera position out of the ground (and the sea): lift it along the local vertical. */
  private aboveGround(pos: V3): V3 {
    const g = worldToGeodetic(pos);
    if (g.h > 3000) return pos; // well clear of any terrain here
    const floor = Math.max(0, this.groundHeight(g.lat, g.lon) ?? 0) + GROUND_CLEARANCE;
    if (g.h >= floor) return pos;
    const up = new THREE.Vector3(pos[0] - EARTH_CENTER[0], pos[1] - EARTH_CENTER[1], pos[2] - EARTH_CENTER[2]).normalize();
    const lift = floor - g.h;
    return [pos[0] + up.x * lift, pos[1] + up.y * lift, pos[2] + up.z * lift];
  }

  cycle(): void {
    this.map = false;
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
  }

  /** Returns the camera world position and field of view for this frame. */
  update(camera: THREE.PerspectiveCamera, target: CameraTarget): V3 {
    if (this.map) return this.updateMap(camera);
    const c = target.center;
    // Local vertical at the target: the pad's +y near Starbase, very different half a world away.
    this.up.set(c[0] - EARTH_CENTER[0], c[1] - EARTH_CENTER[1], c[2] - EARTH_CENTER[2]).normalize();
    this.local.setFromUnitVectors(Y, this.up);
    let pos: V3;
    let fov = 50;
    switch (this.mode) {
      case 'orbit': {
        const ce = Math.cos(this.elevation);
        const off = new THREE.Vector3(ce * Math.sin(this.azimuth), Math.sin(this.elevation), ce * Math.cos(this.azimuth))
          .applyQuaternion(this.local)
          .multiplyScalar(this.distance);
        pos = [c[0] + off.x, c[1] + off.y, c[2] + off.z];
        break;
      }
      case 'chase': {
        // Trail below and to the side of the vehicle, in the plane of its axis.
        const up = this.up.clone();
        const axis = new THREE.Vector3(...target.axis);
        let side = new THREE.Vector3().crossVectors(axis, up);
        if (side.lengthSq() < 1e-6) side = new THREE.Vector3(0, 0, 1);
        side.normalize();
        const back = axis.clone().multiplyScalar(-target.size * 1.6);
        const off = back.add(side.multiplyScalar(target.size * 0.9));
        pos = [c[0] + off.x, c[1] + off.y, c[2] + off.z];
        fov = 55;
        break;
      }
      case 'pad':
      case 'spectator': {
        pos = this.mode === 'pad' ? PAD_CAM : SPECTATOR_CAM;
        // Auto-zoom like a long-lens tracking camera: keep the vehicle a steady size in frame.
        const d = Math.hypot(c[0] - pos[0], c[1] - pos[1], c[2] - pos[2]);
        fov = THREE.MathUtils.clamp(2 * Math.atan((target.size * 1.4) / d) * THREE.MathUtils.RAD2DEG, 0.4, 60);
        break;
      }
    }
    const lifted = this.aboveGround(pos);
    if (lifted !== pos && this.mode === 'orbit') {
      // Pressed against the ground: keep the drag angle where the camera actually is, so
      // dragging back up responds at once.
      const off = new THREE.Vector3(lifted[0] - c[0], lifted[1] - c[1], lifted[2] - c[2]).normalize();
      this.elevation = Math.max(this.elevation, Math.asin(THREE.MathUtils.clamp(off.dot(this.up), -1, 1)));
    }
    pos = lifted;
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    // Camera sits at the floating origin; aim at the target relative to it.
    camera.position.set(0, 0, 0);
    camera.up.copy(this.up);
    camera.lookAt(c[0] - pos[0], c[1] - pos[1], c[2] - pos[2]);
    return pos;
  }
}

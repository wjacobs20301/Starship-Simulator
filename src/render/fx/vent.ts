// Propellant vented overboard in flight (a returning booster or ship dumping what it won't need):
// jets of vapor from the tank vents, freezing into a glittering cloud that spreads out around
// the vehicle in vacuum, or streams away behind it in the air.
//
// Each venting vehicle gets its own particle system anchored on it (world-aligned, moving with
// it): the vented gas leaves with the vehicle's velocity, so relative to it the cloud only
// spreads at the vent speed. In the air it's dragged back to the air's speed (the wind in the
// anchor's frame is the vehicle's air speed, reversed).

import * as THREE from 'three';
import { BOOSTER_LENGTH } from '../../sim/config/starshipV3';
import { toFxLayer } from '../atmosphere';
import type { FloatingOrigin } from '../floatingOrigin';
import { ParticleSystem } from './particles';
import type { FxVehicle } from './launchFx';

interface VentPort {
  stage: 'booster' | 'ship';
  /** Mesh-local position and direction (y along the vehicle's axis, from the booster base). */
  pos: THREE.Vector3;
  dir: THREE.Vector3;
}

const R = 4.6;
const PORTS: VentPort[] = [
  // Booster: LOX / methane vents below the hot-staging ring, both sides.
  { stage: 'booster', pos: new THREE.Vector3(R, 64, 0), dir: new THREE.Vector3(1, -0.1, 0) },
  { stage: 'booster', pos: new THREE.Vector3(-R, 64, 0), dir: new THREE.Vector3(-1, -0.1, 0) },
  // Ship: aft-skirt vents both sides, and the header-tank vent near the top of the tanks.
  { stage: 'ship', pos: new THREE.Vector3(R, BOOSTER_LENGTH + 3, 0), dir: new THREE.Vector3(1, -0.2, 0) },
  { stage: 'ship', pos: new THREE.Vector3(-R, BOOSTER_LENGTH + 3, 0), dir: new THREE.Vector3(-1, -0.2, 0) },
  { stage: 'ship', pos: new THREE.Vector3(0, BOOSTER_LENGTH + 34, -R), dir: new THREE.Vector3(0, 0.1, -1) },
];

/** Particles per second from each vent while venting. */
const RATE = 70;
/** Vent jet speed, m/s (a vacuum jet expands fast). */
const SPEED = 45;
const LIFE: [number, number] = [5, 9];

interface Source {
  group: THREE.Group;
  particles: ParticleSystem;
  acc: number[];
  lastTime: number | null;
  /** Sim time of the last particle (the system is dropped once they've all faded). */
  lastEmit: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class VentFx {
  readonly group = new THREE.Group();
  private sources = new Map<string, Source>();
  private tmp = new THREE.Vector3();

  constructor(private origin: FloatingOrigin) {
    this.group.name = 'VentFx';
  }

  private source(id: string): Source {
    let s = this.sources.get(id);
    if (!s) {
      const particles = new ParticleSystem(4000, [
        // Vented LOX / methane: bright ice-crystal vapor, no buoyancy (drag set by the air).
        { color: new THREE.Color(0.93, 0.95, 0.98), drag: 0, lift: 0, opacity: 0.5, glowPickup: 0 },
      ]);
      particles.uniforms.uGround.value = 0;
      toFxLayer(particles.mesh);
      const group = new THREE.Group();
      group.add(particles.mesh);
      this.group.add(group);
      s = { group, particles, acc: PORTS.map(() => 0), lastTime: null, lastEmit: -Infinity };
      this.sources.set(id, s);
    }
    return s;
  }

  /** Per frame: emit from venting vehicles, keep each cloud with its vehicle. `lighting`: the launch effects' particles, to light the same way. */
  update(time: number, vehicles: FxVehicle[], lighting: ParticleSystem): void {
    const seen = new Set<string>();
    for (const v of vehicles) {
      const snap = v.snap;
      const s = this.sources.get(snap.id) ?? (snap.venting ? this.source(snap.id) : null);
      if (!s) continue;
      seen.add(snap.id);
      this.origin.place(s.group, v.world);
      const p = s.particles;
      p.setTime(time);
      const dt = s.lastTime === null || time < s.lastTime ? 0 : Math.min(time - s.lastTime, 2);
      s.lastTime = time;
      // The air: drag (none in vacuum) toward the air's speed, which in the vehicle's frame is its
      // own air speed reversed (world axes: x = E, y = U, z = -N).
      const tel = snap.telemetry;
      const drag = Math.min(3, tel.pAmb / 300);
      const [ve, vn, vu] = tel.vSurfLocal;
      p.uniforms.uDrag.value[0].x = drag;
      p.uniforms.uWind.value.set(-ve, -vu, vn);
      if (snap.venting) {
        const root = v.mesh.root;
        for (const [i, port] of PORTS.entries()) {
          if (!snap.stages.includes(port.stage)) continue;
          const n0 = s.acc[i] + RATE * dt;
          const n = Math.min(200, Math.floor(n0));
          s.acc[i] = n0 - Math.floor(n0);
          for (let k = 0; k < n; k++) {
            const pos = port.pos.clone().applyQuaternion(root.quaternion);
            const vel = this.tmp.copy(port.dir).applyQuaternion(root.quaternion).normalize().multiplyScalar(SPEED * rand(0.6, 1.2));
            vel.add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(SPEED * 0.35));
            p.emit(0, { pos, vel: vel.clone(), life: rand(...LIFE), size0: rand(1, 2), size1: rand(18, 34) }, time - dt * Math.random());
          }
        }
        s.lastEmit = time;
      }
      p.flush();
      // Lit like the other smoke and vapor.
      const u = p.uniforms;
      const l = lighting.uniforms;
      u.uSunDir.value.copy(l.uSunDir.value);
      u.uSunColor.value.copy(l.uSunColor.value);
      u.uAmbient.value.copy(l.uAmbient.value);
    }
    // Drop clouds that have faded (or whose vehicle is gone).
    for (const [id, s] of this.sources) {
      if (seen.has(id) && time - s.lastEmit < LIFE[1] + 1) continue;
      if (!seen.has(id) || time - s.lastEmit >= LIFE[1] + 1 || time < s.lastEmit - 1) {
        this.group.remove(s.group);
        s.particles.mesh.geometry.dispose();
        (s.particles.mesh.material as THREE.Material).dispose();
        this.sources.delete(id);
      }
    }
  }
}

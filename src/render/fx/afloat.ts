// A stage down in the sea, afloat (the sim leaves it standing where it splashed down): it
// settles a little into the water, rises and falls with the waves and rocks with their slope
// (each a spring, so a tall hull lags and overshoots the sea a little), the waves slapping
// spray up its side. And the splashdown itself: a ring of water thrown up round the base.
//
// All on the render side (ocean.ts's waves, as the sea mesh draws them): the mesh is moved, not
// the vehicle, and the camera framing it stays put, so the sea and the hull move, not the view.
// Each floating vehicle gets its own spray particles, anchored at its waterline.

import * as THREE from 'three';
import { BOOSTER_LENGTH } from '../../sim/config/starshipV3';
import type { V3 } from '../../sim/math';
import { toFxLayer } from '../atmosphere';
import type { FloatingOrigin } from '../floatingOrigin';
import { type SeaPoint, sea } from '../ocean';
import type { FxVehicle } from './launchFx';
import { ParticleSystem } from './particles';

/** Hull radius, m. */
const HULL_R = 4.5;
/** How far it settles into the water, m: the engine section under (its base is the mesh's root). */
const DRAFT = { booster: 6, ship: 5 };
/** Heave and rocking: natural frequencies (rad/s) and damping ratios. */
const HEAVE_W = 1.3;
const HEAVE_Z = 0.4;
const ROCK_W = 0.8;
const ROCK_Z = 0.22;
/** Seconds to settle in from the splashdown. */
const SETTLE = 4;
/** Further than this from the pad (m), a vehicle standing at sea level is in the sea. */
const AT_SEA = 4000;

const WATER = 0;
const MIST = 1;

interface Afloat {
  /** Sim time it was first afloat. */
  since: number;
  heave: number;
  heaveV: number;
  /** Tilt (world: a horizontal vector, its length the angle in rad) and its rate. */
  tilt: THREE.Vector3;
  tiltV: THREE.Vector3;
  group: THREE.Group;
  particles: ParticleSystem;
  /** The waterline's world position (the spray's anchor). */
  anchor: V3;
  lastTime: number | null;
  acc: number;
  /** The sea's rise rate at the hull last frame (for the slap). */
  lastRate: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class AfloatFx {
  readonly group = new THREE.Group();
  /** The floating hulls' waterlines (world) and radii, for the sea's foam round them (oceanSurface.ts). */
  readonly hulls: { at: V3; r: number }[] = [];
  private afloat = new Map<string, Afloat>();
  /** Each vehicle's status last frame (a splashdown is flight -> landed at sea). */
  private lastStatus = new Map<string, string>();
  private pt: SeaPoint = { h: 0, slope: new THREE.Vector3(), rate: 0 };
  private up = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private pivot = new THREE.Vector3();

  constructor(
    private origin: FloatingOrigin,
    private earthCentre: V3,
  ) {
    this.group.name = 'AfloatFx';
  }

  /**
   * Each frame, after the vehicles are placed (origin.place) and before anything reads their
   * meshes' placing. time: sim time (s); lighting: the launch effects' particles, to light the
   * spray the same way.
   */
  update(time: number, vehicles: FxVehicle[], lighting: ParticleSystem): void {
    const seen = new Set<string>();
    this.hulls.length = 0;
    for (const pl of vehicles) {
      const v = pl.snap;
      const was = this.lastStatus.get(v.id);
      this.lastStatus.set(v.id, v.status);
      const w = pl.world;
      const atSea = v.status === 'landed' && Math.hypot(w[0], w[2]) > AT_SEA && v.telemetry.altitude < 60;
      if (!atSea) continue;
      seen.add(v.id);
      // The waterline: the stage's base (the mesh's root is the stack's base; a ship alone sits
      // a booster's length up from it).
      const base = v.stages.includes('booster') ? 0 : BOOSTER_LENGTH;
      const root = pl.mesh.root;
      this.up.set(0, 1, 0).applyQuaternion(root.quaternion);
      const wl: V3 = [w[0] + this.up.x * base, w[1] + this.up.y * base, w[2] + this.up.z * base];
      let a = this.afloat.get(v.id);
      if (!a) {
        a = this.start(v.id, time, wl);
        // (Just come down: the splash.)
        if (was === 'flight') this.splash(a, time);
      }
      const dt = a.lastTime === null || time < a.lastTime ? 0 : Math.min(time - a.lastTime, 0.1);
      a.lastTime = time;

      // The sea round the hull: its height and slope averaged over the waterline (the waves
      // shorter than the hull hardly move it), and how fast it's rising.
      let h = 0, rate = 0;
      const slope = this.v.set(0, 0, 0);
      const local = this.localUp(wl);
      const [e, n] = this.across(local);
      const pts: [number, number][] = [[0, 0], [HULL_R, 0], [-HULL_R, 0], [0, HULL_R], [0, -HULL_R]];
      for (const [x, y] of pts) {
        sea.surfaceAt([wl[0] + e.x * x + n.x * y, wl[1] + e.y * x + n.y * y, wl[2] + e.z * x + n.z * y], 4, this.pt);
        h += this.pt.h / pts.length;
        rate += this.pt.rate / pts.length;
        slope.addScaledVector(this.pt.slope, 1 / pts.length);
      }
      // Heave and rock: springs toward the sea's (settling in over the first seconds).
      const k = smooth(0, SETTLE, time - a.since);
      const draft = base > 0 ? DRAFT.ship : DRAFT.booster;
      if (dt > 0) {
        const acc = HEAVE_W * HEAVE_W * (h - draft - a.heave) - 2 * HEAVE_Z * HEAVE_W * a.heaveV;
        a.heaveV += acc * dt;
        a.heave += a.heaveV * dt;
        const tAcc = slope.clone().sub(a.tilt).multiplyScalar(ROCK_W * ROCK_W).addScaledVector(a.tiltV, -2 * ROCK_Z * ROCK_W);
        a.tiltV.addScaledVector(tAcc, dt);
        a.tilt.addScaledVector(a.tiltV, dt);
      }
      // Move the mesh: tipped about its waterline by the tilt, raised by the heave.
      const angle = Math.min(0.35, a.tilt.length()) * k;
      if (angle > 1e-5) {
        // (Tilting toward the slope's downhill side: the hull leans with the surface's normal.)
        this.axis.crossVectors(local, a.tilt).normalize();
        this.q.setFromAxisAngle(this.axis, -angle);
        this.pivot.set(wl[0] - this.origin.camera[0], wl[1] - this.origin.camera[1], wl[2] - this.origin.camera[2]);
        root.position.sub(this.pivot).applyQuaternion(this.q).add(this.pivot);
        root.quaternion.premultiply(this.q);
      }
      root.position.addScaledVector(local, a.heave * k);
      this.hulls.push({ at: wl, r: HULL_R });

      // Spray: the waves slapping the hull, more as the sea rises past it faster and higher.
      const p = a.particles;
      this.origin.place(a.group, a.anchor);
      p.setTime(time);
      const rel = Math.abs(rate - a.heaveV * k);
      const sev = sea.state;
      const slap = Math.max(0, rel - 0.25) * (0.4 + 0.15 * sev.Hs) + Math.max(0, (rate - a.lastRate) / Math.max(dt, 1e-3)) * 0.05;
      a.lastRate = rate;
      const n0 = a.acc + (dt > 0 ? 160 * Math.min(4, slap) * dt * k : 0);
      const count = Math.min(120, Math.floor(n0));
      a.acc = n0 - count;
      // (Where the water is now, up from the anchor: the still sea there.)
      const lvl = h;
      const wind = sea.uniforms.uSea2.value;
      for (let i = 0; i < count; i++) {
        // On the side the waves come from, mostly.
        const az = Math.atan2(-wind.y, -wind.x) + rand(-1.4, 1.4);
        const dir = this.v.copy(e).multiplyScalar(Math.cos(az)).addScaledVector(n, Math.sin(az));
        const pos = dir.clone().multiplyScalar(HULL_R + rand(0, 0.6)).addScaledVector(local, lvl + rand(-0.3, 0.3));
        const vel = dir.clone().multiplyScalar(rand(1, 4)).addScaledVector(local, rand(3, 6) * (0.6 + 0.3 * Math.min(3, rel)));
        p.emit(WATER, { pos, vel, life: rand(1.2, 2.2), size0: 0.5, size1: 1.2 }, time - dt * Math.random());
        if (Math.random() < 0.25) p.emit(MIST, { pos: pos.clone().addScaledVector(local, 1), vel: vel.multiplyScalar(0.4), life: rand(3, 6), size0: 1.5, size1: rand(5, 9) }, time - dt * Math.random());
      }
      p.flush();
      const u = p.uniforms;
      const l = lighting.uniforms;
      u.uSunDir.value.copy(l.uSunDir.value);
      u.uSunColor.value.copy(l.uSunColor.value);
      u.uAmbient.value.copy(l.uAmbient.value);
      u.uWind.value.copy(l.uWind.value);
    }
    for (const [id, a] of this.afloat) {
      if (seen.has(id)) continue;
      this.group.remove(a.group);
      a.particles.mesh.geometry.dispose();
      (a.particles.mesh.material as THREE.Material).dispose();
      this.afloat.delete(id);
    }
    for (const id of [...this.lastStatus.keys()]) if (!vehicles.some((pl) => pl.snap.id === id)) this.lastStatus.delete(id);
  }

  /** Two horizontal axes square to the vertical `local`. */
  private across(local: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    const ref = Math.abs(local.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const e = new THREE.Vector3().crossVectors(local, ref).normalize();
    return [e, new THREE.Vector3().crossVectors(e, local)];
  }

  /** The local vertical at a world point. */
  private localUp(w: V3): THREE.Vector3 {
    const c = this.earthCentre;
    return new THREE.Vector3(w[0] - c[0], w[1] - c[1], w[2] - c[2]).normalize();
  }

  private start(id: string, time: number, wl: V3): Afloat {
    const particles = new ParticleSystem(5000, [
      // Spray: droplets under gravity, drawn as streaks.
      { color: new THREE.Color(0.86, 0.9, 0.95), drag: 0.15, lift: -9.8, opacity: 0.6, glowPickup: 0.2, streak: 0.06 },
      // Its mist, blown off downwind.
      { color: new THREE.Color(0.92, 0.94, 0.97), drag: 0.8, lift: 0.1, opacity: 0.16, glowPickup: 0.2 },
    ]);
    // (The anchor's ground plane is the still sea: the droplets fall back into it.)
    particles.uniforms.uGround.value = 1;
    toFxLayer(particles.mesh);
    const group = new THREE.Group();
    group.add(particles.mesh);
    this.group.add(group);
    const a: Afloat = {
      since: time,
      heave: 0,
      heaveV: 0,
      tilt: new THREE.Vector3(),
      tiltV: new THREE.Vector3(),
      group,
      particles,
      anchor: [...wl] as V3,
      lastTime: null,
      acc: 0,
      lastRate: 0,
    };
    this.afloat.set(id, a);
    return a;
  }

  /** The splashdown: a ring of water thrown up and out round the base, and a cloud of spray. */
  private splash(a: Afloat, time: number): void {
    const p = a.particles;
    const local = this.localUp(a.anchor);
    const [e, n] = this.across(local);
    for (let i = 0; i < 1400; i++) {
      const az = rand(0, Math.PI * 2);
      const dir = e.clone().multiplyScalar(Math.cos(az)).addScaledVector(n, Math.sin(az));
      const pos = dir.clone().multiplyScalar(HULL_R + rand(0, 2)).addScaledVector(local, rand(0, 1));
      const out = rand(4, 16);
      const vel = dir.clone().multiplyScalar(out).addScaledVector(local, rand(6, 22) * (1 - out / 30));
      p.emit(WATER, { pos, vel, life: rand(2, 4.5), size0: rand(0.6, 1.2), size1: rand(1.5, 2.6) }, time + rand(0, 0.5));
    }
    for (let i = 0; i < 160; i++) {
      const az = rand(0, Math.PI * 2);
      const dir = e.clone().multiplyScalar(Math.cos(az)).addScaledVector(n, Math.sin(az));
      const pos = dir.clone().multiplyScalar(HULL_R + rand(0, 6)).addScaledVector(local, rand(0, 4));
      const vel = dir.clone().multiplyScalar(rand(2, 8)).addScaledVector(local, rand(1, 5));
      p.emit(MIST, { pos, vel, life: rand(6, 12), size0: rand(3, 5), size1: rand(14, 26) }, time + rand(0, 1));
    }
  }
}

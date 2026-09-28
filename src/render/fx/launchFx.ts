// Pad and launch effects around the vehicles:
//  - venting from the booster and ship while they sit fuelled on the pad, and engine chill-down
//    vapor pouring out of the booster's engine bay;
//  - the liftoff cloud: deluge steam and blasted sand spreading out from under the launch mount,
//    and steam hugging the plume while it still reaches the ground; drifts off on the sea breeze;
//  - two shared point lights for the plumes' orange glow (a fixed count so materials never need
//    recompiling when vehicles appear at stage separation);
//  - camera shake from the received sound level (so it arrives with the sound).

import * as THREE from 'three';
import { P0 } from '../../sim/constants';
import { BOOSTER_LENGTH } from '../../sim/config/starshipV3';
import type { V3 } from '../../sim/math';
import type { VehicleSnapshot } from '../../sim/simulation';
import type { FloatingOrigin } from '../floatingOrigin';
import type { VehicleMesh } from '../vehicleMesh';
import { toFxLayer } from '../atmosphere';
import { TRENCHES } from '../launchSite';
import { ParticleSystem } from './particles';

const STEAM = 0;
const DUST = 1;
const VAPOR = 2;
const WATER = 3;
const MIST = 4;
const DEBRIS = 5;

/** Fireball lobes: soft-edged glowing balls (bright face-on, fading to nothing at the rim). */
const boomVertex = /* glsl */ `
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const boomFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    float face = max(0.0, dot(normalize(vN), normalize(vView)));
    float a = uAlpha * pow(face, 1.6);
    gl_FragColor = vec4(uColor * a, a);
  }
`;
const BOOM_ORANGE = new THREE.Color(3.2, 1.1, 0.22);
const BOOM_RED = new THREE.Color(0.7, 0.12, 0.02);

/**
 * Fireball radius, m, for a blast of `propellant` kg of methane / oxygen plus the vehicle's
 * kinetic energy (mass kg, speed m/s): hydrocarbon fireballs grow with the cube root of the fuel
 * (D ~ 5.8 M^(1/3)); the impact energy counts as fuel at ~10 MJ/kg. Floor: the vehicle's own size.
 */
export function explosionRadius(propellant: number, mass: number, speed: number, length: number): number {
  const equivalent = Math.max(0, propellant) + (0.5 * mass * speed * speed) / 1e7;
  return Math.max(length * 0.6, 2.9 * Math.cbrt(equivalent));
}
const MAX_PER_FRAME = 600;
/** Sea breeze from the southeast, m/s (world: x = E, y = U, z = -N). */
const WIND = new THREE.Vector3(-3.2, 0, -2.4);
/** Nominal thrust per engine for loudness, N. */
const ENGINE_THRUST = 2.5e6;

/** A vent on a stage, in the vehicle's mesh-local frame. */
interface Vent {
  stage: 'booster' | 'ship';
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  rate: number;
  /** Venting comes in bursts: cycle period (s) and phase. */
  period: number;
  phase: number;
}

const r = 4.6;
const VENTS: Vent[] = [
  // Booster LOX / methane vents below the hot-staging ring, both sides.
  { stage: 'booster', pos: new THREE.Vector3(r, 64, 0), dir: new THREE.Vector3(1, -0.15, 0), speed: 14, rate: 28, period: 9, phase: 0 },
  { stage: 'booster', pos: new THREE.Vector3(-r, 64, 0), dir: new THREE.Vector3(-1, -0.15, 0), speed: 14, rate: 28, period: 11, phase: 3 },
  { stage: 'booster', pos: new THREE.Vector3(0, 30, r), dir: new THREE.Vector3(0, -0.3, 1), speed: 8, rate: 12, period: 7, phase: 1 },
  // Ship aft-skirt vents and a header-tank vent near the top of the tanks.
  { stage: 'ship', pos: new THREE.Vector3(r, BOOSTER_LENGTH + 3, 0), dir: new THREE.Vector3(1, -0.4, 0), speed: 10, rate: 16, period: 8, phase: 5 },
  { stage: 'ship', pos: new THREE.Vector3(-r, BOOSTER_LENGTH + 3, 0), dir: new THREE.Vector3(-1, -0.4, 0), speed: 10, rate: 16, period: 10, phase: 2 },
  { stage: 'ship', pos: new THREE.Vector3(0, BOOSTER_LENGTH + 34, -r), dir: new THREE.Vector3(0, 0.1, -1), speed: 9, rate: 8, period: 13, phase: 7 },
];

export interface FxVehicle {
  snap: VehicleSnapshot;
  mesh: VehicleMesh;
  /** Float64 world position of the vehicle root. */
  world: V3;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const smooth = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** V3 launch stand (art/blender/pad_v3.py): tunnel half-length along the trench (pier base),
 *  tunnel roof and deck heights, m. */
const STAND_HALF = 17;
const TUNNEL_TOP = 11.5;
const DECK_TOP = 24.5;
/** Launch table half-size (art/blender/pad_v3.py TABLE_HALF), m. */
const TABLE_HALF = 10;
/** Deluge nozzles per ring on the launch deck. */
const DECK_NOZZLES = 24;

export class LaunchFx {
  readonly particles = new ParticleSystem(32000, [
    { color: new THREE.Color(0.86, 0.86, 0.86), drag: 0.3, lift: 0.12, opacity: 0.75, glowPickup: 1 },
    { color: new THREE.Color(0.55, 0.47, 0.37), drag: 0.45, lift: 0.02, opacity: 0.7, glowPickup: 0.8 },
    { color: new THREE.Color(0.95, 0.96, 0.98), drag: 1.1, lift: -0.6, opacity: 0.45, glowPickup: 0.5 },
    // Deluge water: droplets and jets under gravity, drawn as motion streaks.
    { color: new THREE.Color(0.86, 0.9, 0.95), drag: 0.12, lift: -9.8, opacity: 0.65, glowPickup: 0.6, streak: 0.07 },
    // Fine spray mist off the jets: hangs and drifts.
    { color: new THREE.Color(0.92, 0.94, 0.97), drag: 0.9, lift: 0.15, opacity: 0.18, glowPickup: 0.7 },
    // Breakup: dark, sooty smoke and burning debris.
    { color: new THREE.Color(0.2, 0.18, 0.16), drag: 0.6, lift: 0.05, opacity: 0.8, glowPickup: 1 },
  ]);
  /** Breakup fireballs: an expanding, fading additive sphere each. */
  private booms: { mesh: THREE.Mesh; t0: number; size: number; dur: number; rise: number; origin: THREE.Vector3 }[] = [];
  private boomGeo = new THREE.SphereGeometry(1, 32, 20);
  readonly lights = [0, 1].map(() => {
    const l = new THREE.PointLight(0xffa860, 0, 3000, 2);
    l.castShadow = false;
    return l;
  });
  /** Anchored at the pad (world origin); particle positions are relative to it. */
  readonly group = new THREE.Group();
  private acc = new Map<string, number>();
  private lastTime: number | null = null;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private shakeSeed = Math.random() * 100;
  /** Most particles spawned in one frame (keeps a slow frame or a big time step bounded). */
  maxPerFrame = MAX_PER_FRAME;

  constructor(private origin: FloatingOrigin) {
    this.group.name = 'LaunchFx';
    this.group.add(this.particles.mesh);
    toFxLayer(this.particles.mesh);
    this.particles.uniforms.uWind.value.copy(WIND);
  }

  /**
   * A vehicle breaks up: fireball and a cloud of sooty smoke and debris at world position `world`,
   * carried along with velocity `vel` (world, m/s). size: rough vehicle length, m.
   */
  /**
   * A vehicle blowing up at `world`: a fireball `radius` m across its peak (from the propellant
   * and impact energy, see explosionRadius) that billows up and cools from white-yellow through
   * orange to dull red, a spray of debris and a smoke column. air: density ratio there (1 at sea
   * level); high up there's no air to feed a fireball, just a brief flash and glowing debris.
   */
  explode(world: V3, vel: THREE.Vector3, time: number, radius: number, air = 1): void {
    const thin = 1 - Math.min(1, air * 20);
    const R = radius * (1 - 0.75 * thin);
    // Fireball lifetime grows slowly with size (a few seconds to ~10).
    const dur = THREE.MathUtils.clamp(1.2 + 0.018 * R, 2, 10) / (1 + 4 * thin);
    // A cluster of glowing lobes: a big core and smaller ones pushed out and rising.
    const lobes = 7;
    for (let i = 0; i < lobes; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: boomVertex,
        fragmentShader: boomFragment,
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.boomGeo, mat);
      const core = i === 0;
      const dir = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize();
      const offset = core ? new THREE.Vector3() : dir.multiplyScalar(R * rand(0.25, 0.55));
      mesh.position.set(world[0] + offset.x, world[1] + offset.y, world[2] + offset.z);
      toFxLayer(mesh);
      this.group.add(mesh);
      this.booms.push({
        mesh,
        t0: time + (core ? 0 : rand(0, 0.25) * dur),
        size: R * (core ? 0.75 : rand(0.35, 0.55)),
        dur: dur * (core ? 1 : rand(0.6, 0.9)),
        rise: (1 - thin) * R * rand(0.05, 0.12),
        origin: mesh.position.clone(),
      });
    }
    const p = this.particles;
    // Debris and smoke: more, bigger and flung harder for bigger blasts.
    // (Bigger puffs rather than more of them: every puff is drawn over whatever is behind it, and
    // hundreds of screen-filling ones would bring the frame rate down.)
    const count = Math.round(THREE.MathUtils.clamp(180 + R * 0.7, 200, 480));
    const fling = R / Math.max(1, dur);
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      if (thin < 0.5 && dir.y < -0.2) dir.y = -dir.y * 0.3; // (the ground turns it up and out)
      const pos = new THREE.Vector3(...world).addScaledVector(dir, rand(0, R * 0.35));
      const v = vel.clone().multiplyScalar(rand(0.1, 0.35)).addScaledVector(dir, rand(0.3, 1.6) * fling);
      p.emit(
        DEBRIS,
        {
          pos,
          vel: v,
          life: rand(15, 45) * (1 - 0.6 * thin) * THREE.MathUtils.clamp(R / 150, 0.6, 2),
          size0: rand(0.04, 0.09) * R * (1 - 0.6 * thin),
          size1: rand(0.18, 0.4) * R * (1 - 0.8 * thin),
        },
        time + rand(0, 0.6) * dur,
      );
    }
  }

  private updateBooms(time: number): void {
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i];
      const age = time - b.t0;
      if (age > b.dur * 1.6) {
        this.group.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.booms.splice(i, 1);
        continue;
      }
      const u = (b.mesh.material as THREE.ShaderMaterial).uniforms;
      if (age < 0) {
        u.uAlpha.value = 0;
        continue;
      }
      const f = age / b.dur;
      // Swells fast, then slowly; rises as it cools.
      b.mesh.scale.setScalar(b.size * (0.2 + 1.0 * (1 - Math.exp(-f * 5))));
      b.mesh.position.copy(b.origin).y += b.rise * age;
      // Colour temperature: white-yellow -> orange -> dull red (HDR: the bloom makes it blaze).
      const c = u.uColor.value as THREE.Color;
      if (f < 0.25) c.setRGB(6, 4.2, 1.8).lerp(BOOM_ORANGE, f / 0.25);
      else c.copy(BOOM_ORANGE).lerp(BOOM_RED, Math.min(1, (f - 0.25) / 0.75));
      u.uAlpha.value = Math.min(1, age * 25) * Math.exp(-f * 2.2);
    }
  }

  /** Call after vehicles are placed for this frame. time: simulation time, s. */
  /** missionTime: T-/T+ seconds (null before the countdown), for the deluge. */
  update(time: number, missionTime: number | null, vehicles: FxVehicle[], sun: THREE.DirectionalLight, skyBrightness: number): void {
    this.origin.place(this.group, [0, 0, 0]);
    const p = this.particles;
    p.setTime(time);
    const dt = this.lastTime === null || time < this.lastTime ? 0 : Math.min(time - this.lastTime, 5);
    this.lastTime = time;
    let budget = this.maxPerFrame;
    this.updateBooms(time);

    // Emit `rate * dt` particles, with spawn times spread over the frame so warp stays smooth.
    const emit = (key: string, rate: number, spawn: (t: number) => void) => {
      const n0 = (this.acc.get(key) ?? 0) + rate * dt;
      let n = Math.floor(n0);
      this.acc.set(key, n0 - n);
      n = Math.min(n, budget);
      budget -= n;
      for (let i = 0; i < n; i++) spawn(time - dt * Math.random());
    };

    for (const v of vehicles) {
      const s = v.snap;
      const root = v.mesh.root;
      // Anchor-local position of a mesh-local point: render position + camera (floating origin).
      const toAnchor = (local: THREE.Vector3, out: THREE.Vector3) =>
        out.copy(local).applyMatrix4(root.matrixWorld).add(this.tmp2.set(...this.origin.camera));
      const held = s.status === 'held';

      // --- Water deluge: on from T-6 s through liftoff, off by T+15 s ---
      const deluge = missionTime === null ? 0 : smooth(missionTime, -6, -4.5) * (1 - smooth(missionTime, 12, 16));
      const padTrench = TRENCHES.find((tr) => Math.hypot(v.world[0] - tr.center[0], -v.world[2] - tr.center[1]) < 20);
      if (deluge > 0 && padTrench && s.stageState.booster) {
        const cx = padTrench.center[0];
        const cz = -padTrench.center[1];
        const key = `${padTrench.center[0]}`;
        const [ax, an] = padTrench.axis;
        const hl = padTrench.half[0];
        const hw = padTrench.trench.width / 2;
        const at = (u: number, across: number, y: number) =>
          new THREE.Vector3(cx + ax * u - an * across, y, cz - an * u - ax * across);
        // Tall jets out of the water-cooled deck plate around the booster: fine streaks, a few
        // heavier ones, peaking 15-35 m above the deck.
        emit(`${key}:deckJets`, 1100 * deluge, (t) => {
          // Fixed nozzles in two rings: each one a coherent jet, so they read as columns.
          const ring = Math.random() < 0.5 ? 0 : 1;
          const n = Math.floor(Math.random() * DECK_NOZZLES);
          const a = ((n + 0.5 * ring) / DECK_NOZZLES) * Math.PI * 2 + rand(-0.012, 0.012);
          const r = (ring ? 8.6 : 6.1) + rand(-0.15, 0.15);
          const pos = new THREE.Vector3(cx + Math.cos(a) * r, DECK_TOP + 0.4, cz + Math.sin(a) * r);
          const out = rand(0.3, 2.2);
          const heavy = Math.random() < 0.15;
          const vel = new THREE.Vector3(Math.cos(a) * out + rand(-0.4, 0.4), rand(17, 27), Math.sin(a) * out + rand(-0.4, 0.4));
          p.emit(WATER, { pos, vel, life: rand(3.6, 5.2), size0: heavy ? 1.6 : 0.8, size1: heavy ? 2.6 : 1.6 }, t);
        });
        // Mist blown off the jets, near their tops and around the deck.
        emit(`${key}:deckMist`, 30 * deluge, (t) => {
          const a = Math.random() * Math.PI * 2;
          const r = rand(4, 12);
          const pos = new THREE.Vector3(cx + Math.cos(a) * r, DECK_TOP + rand(0, 28), cz + Math.sin(a) * r);
          const vel = new THREE.Vector3(Math.cos(a) * rand(0.5, 2), rand(-0.5, 1.5), Math.sin(a) * rand(0.5, 2));
          p.emit(MIST, { pos, vel, life: rand(5, 9), size0: rand(3, 5), size1: rand(10, 18) }, t);
        });
        // Water sheeting off the launch table's edges and pouring down the stand.
        emit(`${key}:sheets`, 500 * deluge, (t) => {
          const side = Math.floor(Math.random() * 4);
          const along = rand(-TABLE_HALF, TABLE_HALF);
          const [du, dv] = [[1, 0], [-1, 0], [0, 1], [0, -1]][side];
          const u = du * TABLE_HALF + dv * along;
          const v = dv * TABLE_HALF + du * along;
          const pos = at(u, v, DECK_TOP - 0.5);
          const out = rand(1.5, 4);
          const vel = new THREE.Vector3((ax * du - an * dv) * out, rand(-1, 0.5), (-an * du - ax * dv) * out);
          p.emit(WATER, { pos, vel, life: rand(2.2, 2.8), size0: 1.0, size1: 1.8 }, t);
        });
        // Spray nozzles along both trench walls, arcing water across the trench.
        emit(`${key}:trenchJets`, 650 * deluge, (t) => {
          const wall = Math.random() < 0.5 ? -1 : 1;
          const u = rand(-hl + 8, hl - 8);
          const pos = at(u, wall * (hw - 0.3), rand(-1, 0.5));
          const inward = rand(6, 13);
          const vel = new THREE.Vector3(-an * -wall * inward + ax * rand(-1, 1), rand(7, 13), -ax * -wall * inward - an * rand(-1, 1));
          p.emit(WATER, { pos, vel, life: rand(1.8, 2.6), size0: 0.9, size1: 1.8 }, t);
        });
        // Spray and mist surging out of the stand's tunnel mouths.
        emit(`${key}:mouthMist`, 60 * deluge, (t) => {
          const side = Math.random() < 0.5 ? -1 : 1;
          const pos = at(side * rand(STAND_HALF - 2, STAND_HALF + 4), rand(-hw, hw) * 0.8, rand(0.5, 5));
          const vel = new THREE.Vector3(ax * side * rand(4, 10), rand(1, 4), -an * side * rand(4, 10));
          p.emit(MIST, { pos, vel, life: rand(6, 10), size0: rand(3, 5), size1: rand(12, 20) }, t);
        });
      }

      // --- Venting and chill-down while fuelled on the pad ---
      if (held) {
        for (const [i, vent] of VENTS.entries()) {
          if (!s.stageState[vent.stage]) continue;
          const burst = 0.5 + 0.5 * Math.sin(((time + vent.phase) / vent.period) * Math.PI * 2);
          emit(`${s.id}:vent${i}`, vent.rate * Math.max(0, burst * 1.6 - 0.4), (t) => {
            const pos = toAnchor(vent.pos, new THREE.Vector3());
            const vel = vent.dir.clone().transformDirection(root.matrixWorld).multiplyScalar(vent.speed * rand(0.7, 1.2));
            vel.x += rand(-1.5, 1.5);
            vel.z += rand(-1.5, 1.5);
            p.emit(VAPOR, { pos, vel, life: rand(5, 9), size0: 1.5, size1: rand(8, 14) }, t);
          });
        }
        const booster = s.stageState.booster;
        const lit = booster?.throttles.some((x) => x > 0.02);
        if (booster && !lit) {
          emit(`${s.id}:chill`, 45, (t) => {
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(Math.random()) * 3.8;
            const pos = toAnchor(this.tmp.set(rr * Math.cos(a), rand(0.5, 3), rr * Math.sin(a)), new THREE.Vector3());
            const vel = new THREE.Vector3(Math.cos(a) * rand(0.5, 3), -rand(2, 5), Math.sin(a) * rand(0.5, 3));
            p.emit(VAPOR, { pos, vel, life: rand(7, 12), size0: 2.5, size1: rand(10, 18) }, t);
          });
        }
      }

      // --- Liftoff cloud: the booster's exhaust hitting the ground ---
      const bst = s.stageState.booster;
      if (bst) {
        const thrust = bst.throttles.reduce((a, b) => a + b, 0) / bst.throttles.length;
        const h = s.pos[2];
        const reach = 1 / (1 + Math.max(0, (h - 26) / 160) ** 2);
        const strength = thrust * reach;
        if (strength > 0.01) {
          // Where the exhaust meets the ground: straight down the axis from the engines.
          const axis = this.tmp.set(0, 1, 0).applyQuaternion(root.quaternion);
          const base = new THREE.Vector3(...v.world).sub(this.tmp2.set(0, 0, 0));
          const k = axis.y > 0.2 ? h / axis.y : h;
          const impact = base.clone().addScaledVector(axis, -k);
          impact.y = 0;
          // Over a V3 pad the flame trench takes the exhaust: it goes down through the deck onto
          // the diverter, which splits it out through the tunnel under the stand, both ways. It
          // leaves the stand's two tunnel mouths as fast jets, runs down the trench and billows
          // up where the trench ramps back to grade. The stand itself blocks everything else.
          const trench = TRENCHES.find((tr) => Math.hypot(impact.x - tr.center[0], -impact.z - tr.center[1]) < 20);
          if (trench) {
            const [ax, an] = trench.axis;
            const hl = trench.half[0];
            const hw = trench.trench.width / 2;
            const cx = trench.center[0];
            const cz = -trench.center[1];
            const at = (u: number, across: number, y: number) =>
              new THREE.Vector3(cx + ax * u - an * across, y, cz - an * u - ax * across);
            const along = (side: number, speed: number, spread: number, up: number) =>
              new THREE.Vector3((ax * side - an * spread) * speed, up, (-an * side - ax * spread) * speed);
            // Jets out of the tunnel mouths, confined to the trench's width and the tunnel's height.
            emit(`${s.id}:mouth`, 280 * strength, (t) => {
              const side = Math.random() < 0.5 ? -1 : 1;
              const pos = at(side * rand(STAND_HALF, STAND_HALF + 5), rand(-hw, hw) * 0.8, rand(1, TUNNEL_TOP - 2));
              const vel = along(side, rand(50, 110) * (0.4 + 0.6 * strength), rand(-0.12, 0.12), rand(1, 6));
              const dust = Math.random() < 0.2;
              p.emit(dust ? DUST : STEAM, { pos, vel, life: rand(28, 50), size0: rand(6, 10), size1: rand(45, 85) }, t);
            });
            // Big billows where the trench ramps up at its far ends.
            emit(`${s.id}:ends`, 110 * strength, (t) => {
              const side = Math.random() < 0.5 ? -1 : 1;
              const pos = at(side * rand(hl - 14, hl), rand(-hw, hw), rand(2, 8));
              const vel = along(side, rand(20, 45), rand(-0.4, 0.4), rand(10, 24));
              p.emit(Math.random() < 0.3 ? DUST : STEAM, { pos, vel, life: rand(30, 50), size0: rand(10, 16), size1: rand(60, 100) }, t);
            });
            // A little steam boiling up out of the open trench between the stand and the ends.
            emit(`${s.id}:slot`, 30 * strength, (t) => {
              const side = Math.random() < 0.5 ? -1 : 1;
              const pos = at(side * rand(STAND_HALF + 4, hl - 12), rand(-hw, hw) * 0.7, rand(0, 4));
              const vel = along(side, rand(10, 30), 0, rand(8, 18));
              p.emit(STEAM, { pos, vel, life: rand(20, 35), size0: rand(8, 12), size1: rand(35, 60) }, t);
            });
          } else {
            // Bare ground: the exhaust spreads out in every direction.
            emit(`${s.id}:cloud`, 320 * strength, (t) => {
              const a = Math.random() * Math.PI * 2;
              const speed = rand(25, 75) * (0.4 + 0.6 * strength);
              const dust = Math.random() < 0.3;
              const pos = new THREE.Vector3(impact.x + Math.cos(a) * rand(4, 16), rand(2, 10), impact.z + Math.sin(a) * rand(4, 16));
              const vel = new THREE.Vector3(Math.cos(a) * speed, rand(1, 12), Math.sin(a) * speed);
              p.emit(dust ? DUST : STEAM, { pos, vel, life: rand(28, 50), size0: rand(8, 14), size1: rand(45, 85) }, t);
            });
          }
          // Steam billowing around the plume column while it's short; over a stand only above
          // its deck (below, the plume is inside the structure).
          const floor = trench ? DECK_TOP : 5;
          const column = Math.min(60, Math.max(0, h - floor));
          if (column > 0 && h < 160) {
            emit(`${s.id}:column`, 70 * strength, (t) => {
              const a = Math.random() * Math.PI * 2;
              const f = Math.random() ** 1.5;
              const pos = base.clone().addScaledVector(axis, -k + floor).addScaledVector(axis, column * f);
              pos.x += Math.cos(a) * rand(8, 14);
              pos.z += Math.sin(a) * rand(8, 14);
              const vel = new THREE.Vector3(Math.cos(a) * rand(8, 20), rand(2, 10), Math.sin(a) * rand(8, 20));
              p.emit(STEAM, { pos, vel, life: rand(20, 35), size0: 10, size1: rand(35, 60) }, t);
            });
          }
        }
      }
    }
    p.flush();

    // --- Plume lights: the two brightest plumes ---
    const plumes = vehicles.flatMap((v) => [...v.mesh.plumes.values()]).filter((pl) => pl.glowPower > 0);
    plumes.sort((a, b) => b.glowPower - a.glowPower);
    this.lights.forEach((l, i) => {
      const pl = plumes[i];
      l.intensity = pl ? pl.glowPower * (0.9 + 0.1 * Math.sin(time * 40 + i)) : 0;
      if (pl) l.position.copy(pl.glowPoint).applyMatrix4(pl.group.matrixWorld);
      p.uniforms.uGlowPos.value[i].copy(l.position);
      // The particles' falloff has a 20 m core; scale to roughly match the real light.
      p.uniforms.uGlowPower.value[i] = l.intensity * 0.5;
    });

    // Smoke lighting follows the sun and sky.
    p.uniforms.uSunDir.value.copy(sun.position).sub(sun.target.position).normalize();
    p.uniforms.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity * 0.42);
    p.uniforms.uAmbient.value.setRGB(0.3, 0.34, 0.4).multiplyScalar(skyBrightness);
  }

  /**
   * Shake the camera by the received sound level (dB). Angular amplitude scales with the field
   * of view so long-lens tracking cameras shake by the same fraction of the frame.
   */
  shake(camera: THREE.PerspectiveCamera, level: number, realTime: number): void {
    if (!Number.isFinite(level) || level < 110) return;
    const pressure = Math.min(1.5, 10 ** ((level - 150) / 20));
    const amp = pressure * 0.012 * THREE.MathUtils.degToRad(camera.fov);
    const t = realTime + this.shakeSeed;
    const n = (f: number, o: number) => Math.sin(t * f + o) * 0.6 + Math.sin(t * f * 2.3 + o * 1.7) * 0.4;
    camera.rotateX(amp * n(23, 0));
    camera.rotateY(amp * n(19, 2));
    camera.rotateZ(amp * 0.4 * n(17, 4));
  }
}

/** Nominal sound power inputs for a vehicle: thrust (N) and the source position (world). */
export function vehicleNoise(v: FxVehicle): { thrust: number; pressureRatio: number; pos: V3 } {
  let lit = 0;
  for (const s of Object.values(v.snap.stageState)) if (s) for (const t of s.throttles) lit += t > 0.02 ? t : 0;
  // Most noise is made where the jet mixes with the air, a few tens of metres downstream.
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(v.mesh.root.quaternion);
  const x = v.snap.stageState.booster ? -40 : BOOSTER_LENGTH - 30;
  const pos: V3 = [v.world[0] + axis.x * x, v.world[1] + axis.y * x, v.world[2] + axis.z * x];
  return { thrust: lit * ENGINE_THRUST, pressureRatio: v.snap.telemetry.pAmb / P0, pos };
}
